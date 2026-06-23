Cost page do not showing the settings navigation fix that please.
→ ## Done — fix on `fix/cost-page-settings-nav`

**Root cause:** The Settings page has a custom secondary sub-nav (General · Engines · Skills · **Costs** · Accounts · Security · …). Costs and Skills are "launcher" keys — they `navigate('/budget')` and `navigate('/skills-registry')` respectively. But `