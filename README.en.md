# workbuddy SkillHub Skill Auto Publisher

Validate, package, and submit a local AI Skill to SkillHub through an already authenticated browser controlled by Easy WebBridge. No third-party API key is required.

Use `validate`, `plan`, and `preflight` first. `publish` uploads the ZIP, icon, and metadata; add `--submit` only when the current task explicitly authorizes clicking “Submit for review”. Login, identity verification, CAPTCHA, risk controls, and platform rejection are reported as user-action blockers.
