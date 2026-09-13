#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BRIDGE_URL = (process.env.EASY_WEBBRIDGE_URL || "http://127.0.0.1:17777").replace(/\/$/, "");
const SKILLHUB_URL = process.env.SKILLHUB_PUBLISH_URL || "https://skillhub.cn/dashboard/publish";
const DEFAULT_CHANGELOG = "首个公开版本：完善 SkillHub 发布流程，支持 Easy WebBridge 浏览器自动化。";
const REQUIRED_FILES = ["SKILL.md", "manifest.yaml", "LICENSE"];
const ZIP_EXCLUDES = [
  ".git/*", ".factory/*", "dist/*", "node_modules/*", ".gitignore", ".DS_Store", "LICENSE",
  ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx",
];

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const positional = [];
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const key = item.slice(2).replaceAll("-", "_");
    if (["submit", "close_tab"].includes(key)) {
      flags[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail("invalid-args", `${item} 需要一个值`);
    flags[key] = value;
    index += 1;
  }
  return { command, positional, flags };
}

function usage() {
  process.stdout.write(`workbuddy SkillHub skill 自动发布\n\n用法：\n  node scripts/skillhub-publish.mjs validate <skill-dir>\n  node scripts/skillhub-publish.mjs plan <skill-dir>\n  node scripts/skillhub-publish.mjs package <skill-dir>\n  node scripts/skillhub-publish.mjs preflight\n  node scripts/skillhub-publish.mjs publish <skill-dir> --browser-id <id>\n  node scripts/skillhub-publish.mjs publish <skill-dir> --display-name <name> [--submit] [--close-tab]\n  node scripts/skillhub-publish.mjs self-test\n\npublish 默认上传并填写，停在“提交审核”前；只有显式 --submit 才提交。\n`);
}

function scalar(value) {
  const text = String(value ?? "").trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).replaceAll('\\"', '"').replaceAll("''", "'");
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  return text;
}

// Skill manifests only need a small, dependency-free YAML reader: top-level
// scalars and lists. Nested runtime metadata is preserved as an opaque value.
function parseManifestYaml(text) {
  const result = {};
  let listKey = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listItem = line.match(/^\s+-\s*(.*)$/);
    if (listItem && listKey) {
      if (!Array.isArray(result[listKey])) result[listKey] = [];
      result[listKey].push(scalar(listItem[1]));
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!pair) {
      listKey = null;
      continue;
    }
    const [, key, rawValue = ""] = pair;
    if (!rawValue.trim()) {
      result[key] = [];
      listKey = key;
    } else {
      result[key] = scalar(rawValue);
      listKey = null;
    }
  }
  return result;
}

function parseFrontmatter(text) {
  const match = String(text).match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  return match ? parseManifestYaml(match[1]) : null;
}

function isInside(root, path) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function pngInfo(path) {
  const buffer = await readFile(path);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature) || buffer.toString("ascii", 12, 16) !== "IHDR") {
    fail("invalid-icon", `图标不是有效 PNG：${path}`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length };
}

function semver(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

async function validateSkill(inputDir) {
  const dir = resolve(inputDir || ".");
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) fail("skill-not-found", `Skill 目录不存在：${dir}`);
  const missing = [];
  for (const name of REQUIRED_FILES) if (!(await exists(join(dir, name)))) missing.push(name);
  if (missing.length) fail("missing-file", `缺少必需文件：${missing.join(", ")}`, { missing });

  const manifestText = await readFile(join(dir, "manifest.yaml"), "utf8");
  const manifest = parseManifestYaml(manifestText);
  const skillText = await readFile(join(dir, "SKILL.md"), "utf8");
  const frontmatter = parseFrontmatter(skillText);
  if (!frontmatter?.name || !frontmatter?.description) fail("invalid-skill", "SKILL.md 必须包含 name 和 description frontmatter");
  const slug = String(manifest.slug || manifest.name || frontmatter.name || "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64) fail("invalid-slug", `slug 必须是小写短横线格式：${slug}`);
  const version = String(manifest.version || "").trim();
  if (!semver(version)) fail("invalid-version", `version 必须是 x.y.z 格式：${version}`);
  const description = String(manifest.description || frontmatter.description || "").trim();
  if (!description) fail("invalid-description", "manifest.yaml 缺少 description");
  if ([...description].length > 1024) fail("invalid-description", "description 不能超过 1024 个字符");

  const declaredIcon = manifest.icon == null ? "" : String(manifest.icon).trim();
  const iconCandidates = declaredIcon ? [declaredIcon] : ["icon-512.png", "assets/icon-512.png"];
  let iconRelative = null;
  for (const candidate of iconCandidates) {
    if (isInside(dir, resolve(dir, candidate)) && await exists(resolve(dir, candidate))) {
      iconRelative = candidate;
      break;
    }
  }
  if (!iconRelative) fail("missing-icon", `缺少 512×512 PNG 图标（支持 icon-512.png 或 assets/icon-512.png）`);
  const iconPath = resolve(dir, iconRelative);
  const icon = await pngInfo(iconPath);
  if (icon.width !== 512 || icon.height !== 512) fail("invalid-icon", `图标必须是 512×512 PNG，当前为 ${icon.width}×${icon.height}`, { icon });

  const warnings = [];
  if (!(await exists(join(dir, "agents", "openai.yaml")))) warnings.push("未找到 agents/openai.yaml（SkillHub 仍可发布，但建议补齐界面元数据）");
  if (!(await exists(join(dir, "README.md")))) warnings.push("未找到 README.md（不影响 SkillHub 运行）");
  return {
    dir,
    slug,
    displayName: String(manifest.display_name || manifest.name || slug),
    version,
    description,
    license: String(manifest.license || ""),
    iconPath,
    iconRelative,
    icon,
    manifest,
    warnings,
  };
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolveProcess({ code, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
  });
}

async function packageSkill(inputDir, validation = null) {
  const checked = validation || await validateSkill(inputDir);
  const distDir = join(checked.dir, "dist");
  await mkdir(distDir, { recursive: true });
  const zipPath = join(distDir, `${checked.slug}-${checked.version}.zip`);
  await rm(zipPath, { force: true });
  const excludes = ZIP_EXCLUDES.flatMap((pattern) => ["-x", pattern]);
  const zipped = await runProcess("zip", ["-X", "-q", "-r", zipPath, ".", ...excludes], { cwd: checked.dir });
  if (zipped.code !== 0) fail("package-failed", `zip 打包失败：${zipped.stderr.trim() || `exit ${zipped.code}`}`);
  const listed = await runProcess("unzip", ["-Z1", zipPath]);
  if (listed.code !== 0) fail("package-failed", `无法读取 zip 内容：${listed.stderr.trim()}`);
  const entries = listed.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  // SkillHub currently rejects LICENSE as an uploaded archive entry. The
  // repository still requires and validates it, but the platform package
  // deliberately omits it.
  for (const required of ["SKILL.md", "manifest.yaml", checked.iconRelative]) {
    if (!entries.includes(required)) fail("package-failed", `zip 缺少 ${required}`);
  }
  const digest = createHash("sha256").update(await readFile(zipPath)).digest("hex");
  return { ...checked, zipPath, zipBytes: (await stat(zipPath)).size, sha256: digest, entries };
}

async function readBridgeToken() {
  if (process.env.EASY_WEBBRIDGE_TOKEN) return process.env.EASY_WEBBRIDGE_TOKEN.trim();
  const path = process.env.EASY_WEBBRIDGE_TOKEN_FILE || join(homedir(), ".easy-webbridge", "bridge-token");
  const token = await readFile(path, "utf8").catch(() => "");
  if (!token.trim()) fail("needs-user-action", `找不到 Easy WebBridge token：${path}`);
  return token.trim();
}

async function bridgeRequest(path, init = {}, { auth = true } = {}) {
  const headers = { Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) };
  if (auth) headers.Authorization = `Bearer ${await readBridgeToken()}`;
  const response = await fetch(`${BRIDGE_URL}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) fail(response.status === 401 ? "needs-user-action" : "bridge-error", body.error || `Easy WebBridge HTTP ${response.status}`);
  return body;
}

async function bridgeCommand(browserId, action, args = {}, timeoutMs = 30_000) {
  const body = await bridgeRequest(`/v1/browsers/${encodeURIComponent(browserId)}/commands`, {
    method: "POST",
    body: JSON.stringify({ action, args, timeoutMs }),
  });
  return body.result ?? body;
}

async function preflight() {
  const health = await bridgeRequest("/health", {}, { auth: false }).catch((error) => {
    fail("needs-user-action", `Easy WebBridge 未运行：${BRIDGE_URL}`, { cause: error.message });
  });
  const response = await bridgeRequest("/v1/browsers");
  const browsers = (response.browsers || []).filter((item) => item.online !== false).map((item) => ({
    browserId: String(item.browserId || item.id || ""),
    displayName: String(item.displayName || item.name || item.browserId || ""),
    platform: item.platform || null,
  }));
  return { ok: true, runtime: { url: BRIDGE_URL, service: health.service || "easy-webbridge" }, browsers };
}

function chooseBrowser(browsers, flags) {
  const requestedId = flags.browser_id ? String(flags.browser_id) : "";
  const requestedName = flags.display_name ? String(flags.display_name) : "";
  if (!requestedId && !requestedName) fail("needs-user-action", "必须指定 --browser-id 或 --display-name，不能猜登录账号");
  const found = browsers.find((browser) => (requestedId && browser.browserId === requestedId) || (requestedName && browser.displayName === requestedName));
  if (!found) fail("needs-user-action", `指定浏览器不在线：${requestedId || requestedName}`);
  return found;
}

function snapshotText(snapshot) {
  return String(snapshot?.text || "");
}

function findInteractive(snapshot, labels, { partial = false } = {}) {
  const expected = labels.map((item) => String(item));
  return (snapshot?.interactive || []).find((item) => {
    if (item.visible === false) return false;
    const text = String(item.text || "").trim();
    return expected.some((label) => partial ? text.includes(label) : text === label);
  }) || null;
}

async function clickLabel(browserId, tabId, snapshot, labels, options = {}) {
  const element = findInteractive(snapshot, labels, options);
  if (!element?.ref) fail("needs-user-action", `页面未找到按钮：${labels.join(" / ")}`);
  await bridgeCommand(browserId, "click", { selector: element.ref, tabId });
}

async function trustedClickLabel(browserId, tabId, label) {
  const code = `(() => { const label = ${JSON.stringify(label)}; const element = [...document.querySelectorAll("button,[role=tab]")].find((item) => (item.textContent || "").trim() === label); if (!element) return null; element.scrollIntoView({ block: "center", inline: "center" }); const rect = element.getBoundingClientRect(); return JSON.stringify({x: rect.x + rect.width / 2, y: rect.y + rect.height / 2}); })()`;
  const value = await evaluate(browserId, tabId, code);
  if (typeof value !== "string" || !value) fail("needs-user-action", `页面未找到可点击的按钮：${label}`);
  const point = JSON.parse(value);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await bridgeCommand(browserId, "cdp", { tabId, method: "Input.dispatchMouseEvent", params: { type, x: point.x, y: point.y, button: "left", clickCount: 1 } });
  }
}

async function takeSnapshot(browserId, tabId) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await bridgeCommand(browserId, "snapshot", { tabId, maxTextLength: 24_000 });
    } catch (error) {
      lastError = error;
      if (!/frame with id .* removed|no such frame|target closed/i.test(String(error?.message || error))) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 500 + attempt * 250));
    }
  }
  throw lastError || new Error("SkillHub 页面快照失败");
}

async function waitSnapshot(browserId, tabId, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  do {
    latest = await takeSnapshot(browserId, tabId);
    if (predicate(latest)) return latest;
    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  } while (Date.now() < deadline);
  return latest;
}

async function evaluate(browserId, tabId, code) {
  return bridgeCommand(browserId, "evaluate", { tabId, code });
}

async function waitForFileInput(browserId, tabId, selector, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const present = await evaluate(browserId, tabId, `Boolean(document.querySelector(${JSON.stringify(selector)}))`).catch(() => false);
    if (present === true) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  } while (Date.now() < deadline);
  fail("needs-user-action", `页面未生成文件选择框：${selector}`);
}

async function verifyPublishFields(browserId, tabId, fields) {
  const labels = {
    "#skill-slug": "Slug",
    "#skill-displayName": "Skill 名称",
    "#skill-summaryZh": "Skill 描述",
    "#skill-version": "版本号",
    "#skill-changelog": "变更说明",
  };
  for (const [selector, expected] of fields) {
    const actual = await evaluate(browserId, tabId, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); return element && "value" in element ? String(element.value || "") : null; })()`);
    if (typeof actual !== "string" || actual.trim() !== String(expected).trim()) {
      fail("needs-user-action", `SkillHub ${labels[selector] || selector} 未成功写入，请检查表单后重试`);
    }
  }
}

async function findOrOpenSkillhubTab(browserId) {
  const tabs = await bridgeCommand(browserId, "list_tabs", {});
  const existing = Array.isArray(tabs)
    ? tabs.find((tab) => typeof tab.id === "number" && /^https:\/\/(?:www\.)?skillhub\.cn\/dashboard(?:\/|$)/i.test(String(tab.url || "")))
    : null;
  if (existing?.id !== undefined) {
    const tabId = Number(existing.id);
    await bridgeCommand(browserId, "activate_tab", { tabId });
    await bridgeCommand(browserId, "cdp", { tabId, method: "Page.navigate", params: { url: SKILLHUB_URL } });
    return { tabId, created: false };
  }
  const session = `workbuddy-skillhub-${Date.now()}`;
  const opened = await bridgeCommand(browserId, "navigate", { url: SKILLHUB_URL, newTab: true, active: true, session, groupTitle: "workbuddy SkillHub" });
  const tabId = Number(opened.tabId ?? opened.id);
  if (!Number.isInteger(tabId)) fail("bridge-error", "Easy WebBridge 没有返回新标签页 ID");
  return { tabId, created: true, session };
}

async function ensurePublishForm(browserId, tabId) {
  let snapshot = await waitSnapshot(browserId, tabId, (value) => /发布新技能|发布 Skill|最快上架|请先登录|立即登录|login|sign in/i.test(snapshotText(value)));
  const text = snapshotText(snapshot);
  if (/请先登录|立即登录|login|sign in/i.test(text) && !/退出登录|logout/i.test(text)) {
    fail("needs-user-action", "SkillHub 页面要求登录，请先在指定 EasyBR 环境登录");
  }
  if (!/发布新技能/.test(text)) {
    await clickLabel(browserId, tabId, snapshot, ["发布 Skill\n最快上架", "最快上架"], { partial: true });
    snapshot = await waitSnapshot(browserId, tabId, (value) => /发布新技能/.test(snapshotText(value)));
  }
  if (!/发布新技能/.test(snapshotText(snapshot))) fail("needs-user-action", "未进入 SkillHub 发布表单，请检查页面是否改版");
  return snapshot;
}

async function uploadIcon(browserId, tabId, iconPath) {
  let snapshot = await takeSnapshot(browserId, tabId);
  const currentText = snapshotText(snapshot);
  if (/已上传 Skill 图标|已选图标|图标审核中/.test(currentText)) {
    const existingUrl = await waitIconUrl(browserId, tabId);
    if (existingUrl) return existingUrl;
  }
  const custom = findInteractive(snapshot, ["自定义"]);
  if (custom) await trustedClickLabel(browserId, tabId, "自定义");
  snapshot = await waitSnapshot(browserId, tabId, (value) => /点击上传图片/.test(snapshotText(value)));
  await trustedClickLabel(browserId, tabId, "点击上传图片");
  const dialog = await waitSnapshot(browserId, tabId, (value) => /上传 Skill 图标|点击选择图片/.test(snapshotText(value)));
  if (!dialog || !/上传/.test(snapshotText(dialog))) fail("needs-user-action", "图标上传窗口未打开");
  const imageSelector = 'input[type="file"][accept*="image"]';
  await waitForFileInput(browserId, tabId, imageSelector);
  await bridgeCommand(browserId, "upload", { selector: imageSelector, files: [iconPath], tabId }, 60_000);
  const cropReady = await waitSnapshot(browserId, tabId, (value) => Boolean(findInteractive(value, ["上传"])), 20_000);
  if (!cropReady) fail("needs-user-action", "SkillHub 未完成图标读取或裁剪");
  await clickLabel(browserId, tabId, cropReady, ["上传"]);
  const saved = await waitSnapshot(browserId, tabId, (value) => /重新上传|已上传 Skill 图标|已选图标|图标审核中/.test(snapshotText(value)), 30_000);
  if (!saved) fail("needs-user-action", "SkillHub 图标上传未完成");
  const iconUrl = await waitIconUrl(browserId, tabId);
  if (!iconUrl) fail("needs-user-action", "图标状态已变化，但尚未读取到 SkillHub 远程图标地址");
  return iconUrl;
}

async function waitIconUrl(browserId, tabId) {
  const code = `(() => { const panels = [...document.querySelectorAll('[role="tabpanel"]')].filter((panel) => panel.getClientRects().length); const image = panels.flatMap((panel) => [...panel.querySelectorAll('img')]).find((item) => { const src = item.currentSrc || item.src || ''; const alt = (item.alt || '').trim(); const text = item.closest('[role="tabpanel"]')?.textContent || ''; return item.getClientRects().length && /^https?:\\/\\//i.test(src) && (alt.includes('已上传 Skill 图标') || alt.includes('已选图标') || text.includes('重新上传') || text.includes('图标审核中')); }); return image?.currentSrc || image?.src || null; })()`;
  const deadline = Date.now() + 20_000;
  do {
    const value = await evaluate(browserId, tabId, code).catch(() => null);
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  } while (Date.now() < deadline);
  return null;
}

async function publishSkill(inputDir, flags) {
  const checked = await validateSkill(inputDir);
  const packaged = await packageSkill(inputDir, checked);
  const runtime = await preflight();
  const browser = chooseBrowser(runtime.browsers, flags);
  const opened = await findOrOpenSkillhubTab(browser.browserId);
  const { browserId, displayName } = browser;
  try {
    let snapshot = await ensurePublishForm(browserId, opened.tabId);
    await bridgeCommand(browserId, "upload", { selector: 'input[type="file"][accept*=".zip"]', files: [packaged.zipPath], tabId: opened.tabId }, 60_000);
    const changelog = String(flags.changelog || DEFAULT_CHANGELOG);
    const displayNameValue = String(flags.skill_name || packaged.displayName);
    const fields = [
      ["#skill-slug", packaged.slug],
      ["#skill-displayName", displayNameValue],
      ["#skill-summaryZh", packaged.description],
      ["#skill-version", packaged.version],
      ["#skill-changelog", changelog],
    ];
    for (const [selector, value] of fields) await bridgeCommand(browserId, "fill", { selector, value, tabId: opened.tabId });
    await verifyPublishFields(browserId, opened.tabId, fields);
    const iconUrl = await uploadIcon(browserId, opened.tabId, packaged.iconPath);
    snapshot = await takeSnapshot(browserId, opened.tabId);
    const result = {
      ok: true,
      status: flags.submit ? "submitting" : "awaiting_confirmation",
      skill: packaged.slug,
      displayName: displayNameValue,
      version: packaged.version,
      browserId,
      browserName: displayName,
      tabId: opened.tabId,
      zip: { path: packaged.zipPath, bytes: packaged.zipBytes, sha256: packaged.sha256 },
      icon: { path: packaged.iconPath, url: iconUrl },
      fieldsFilled: fields.map(([selector]) => selector),
      submitRequired: !Boolean(flags.submit),
    };
    if (!flags.submit) {
      print(result);
      return;
    }
    await clickLabel(browserId, opened.tabId, snapshot, ["提交审核"], { partial: true });
    let after = await waitSnapshot(browserId, opened.tabId, (value) => /确认发布|待审核|审核中|提交成功|提交失败|需要完成实名认证|不允许的文件类型|under review|pending review/i.test(snapshotText(value)), 30_000);
    let confirmation = snapshotText(after).replaceAll("图标审核中", "");
    if (/确认发布/.test(confirmation) && /同名 slug|命名空间/.test(confirmation)) {
      await clickLabel(browserId, opened.tabId, after, ["确认发布"]);
      after = await waitSnapshot(browserId, opened.tabId, (value) => /待审核|审核中|提交成功|提交失败|需要完成实名认证|不允许的文件类型|under review|pending review/i.test(snapshotText(value)), 30_000);
      confirmation = snapshotText(after).replaceAll("图标审核中", "");
    }
    if (/需要完成实名认证/.test(confirmation)) fail("needs-user-action", "SkillHub 要求完成实名认证，请先完成认证");
    if (/提交失败|不允许的文件类型/i.test(confirmation)) {
      const detail = confirmation.split(/\r?\n/).map((line) => line.trim()).find((line) => /提交失败|不允许的文件类型/i.test(line));
      fail("needs-user-action", `SkillHub 返回提交失败${detail ? `：${detail}` : "，请检查页面提示"}`);
    }
    if (!/待审核|审核中|提交成功|under review|pending review/i.test(confirmation)) fail("uncertain", "已点击提交，但页面没有出现 SkillHub 确认文案");
    print({ ...result, status: /待审核|审核中|under review|pending review/i.test(confirmation) ? "under_review" : "submitted", submitRequired: false });
  } finally {
    // Existing user tabs are borrowed and never closed. A newly opened tab is
    // left visible so a person can inspect the filled form or platform receipt.
    if (opened.created && flags.close_tab && opened.session) {
      await bridgeCommand(browserId, "close_session", { session: opened.session }).catch(() => undefined);
    }
  }
}

async function commandMain(command, positional, flags) {
  if (command === "help") return usage();
  if (command === "self-test") return selfTest();
  if (command === "preflight") return print(await preflight());
  const dir = positional[0];
  if (!dir) fail("invalid-args", `${command} 需要 Skill 目录路径`);
  if (command === "validate") {
    const checked = await validateSkill(dir);
    return print({ ok: true, status: "validated", skill: checked.slug, displayName: checked.displayName, version: checked.version, icon: checked.icon, warnings: checked.warnings });
  }
  if (command === "plan") {
    const checked = await validateSkill(dir);
    return print({ ok: true, status: "validated", skill: checked.slug, version: checked.version, steps: ["校验 SKILL.md、manifest.yaml、LICENSE 和 512×512 PNG 图标", "生成不含 .git、dist、过程目录和凭据的 ZIP", "复用已登录 SkillHub 浏览器上传 ZIP、图标并填写表单", "默认停在提交前；显式 --submit 才提交审核"], warnings: checked.warnings });
  }
  if (command === "package") {
    const packaged = await packageSkill(dir);
    return print({ ok: true, status: "packaged", skill: packaged.slug, version: packaged.version, zip: { path: packaged.zipPath, bytes: packaged.zipBytes, sha256: packaged.sha256 }, entries: packaged.entries });
  }
  if (command === "publish") return publishSkill(dir, flags);
  fail("invalid-args", `未知命令：${command}`);
}

async function selfTest() {
  const dir = join(tmpdir(), `easy-skillhub-self-test-${Date.now()}`);
  await mkdir(join(dir, "assets"), { recursive: true });
  await mkdir(join(dir, ".factory"), { recursive: true });
  await mkdir(join(dir, "dist"), { recursive: true });
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(512, 16);
  png.writeUInt32BE(512, 20);
  await writeFile(join(dir, "SKILL.md"), "---\nname: demo-skill\ndescription: A demo skill for self test.\n---\n\n# Demo\n");
  await writeFile(join(dir, "manifest.yaml"), "name: demo-skill\ndisplay_name: Demo Skill\nslug: demo-skill\nversion: 1.2.3\ndescription: Demo Skill\nicon: assets/icon-512.png\nlicense: MIT\n");
  await writeFile(join(dir, "LICENSE"), "MIT\n");
  await writeFile(join(dir, "assets", "icon-512.png"), png);
  await writeFile(join(dir, ".gitignore"), "dist/\n");
  await writeFile(join(dir, ".env"), "SHOULD_NOT_BE_PACKAGED=1\n");
  await writeFile(join(dir, ".factory", "progress.json"), "{}\n");
  await writeFile(join(dir, "dist", "old.zip"), "old\n");
  try {
    const checked = await validateSkill(dir);
    const packaged = await packageSkill(dir, checked);
    const bad = packaged.entries.some((entry) => entry.startsWith(".git/") || entry.startsWith("dist/") || entry.startsWith(".factory/") || entry === ".gitignore" || entry === ".env");
    if (bad) fail("self-test-failed", "zip 包含被排除的过程文件");
    if (packaged.entries.includes("LICENSE")) fail("self-test-failed", "SkillHub 上传包不应包含 LICENSE");
    print({ ok: true, status: "passed", tests: ["manifest and frontmatter", "512×512 PNG", "ZIP required entries", "ZIP excludes process files and LICENSE"], zipBytes: packaged.zipBytes });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const { command, positional, flags } = parseArgs(process.argv.slice(2));
commandMain(command, positional, flags).catch((error) => {
  print({ ok: false, status: error.code || "failed", error: error.message, details: error.details || undefined });
  process.exitCode = 1;
});
