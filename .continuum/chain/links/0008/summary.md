In the CodeSpace I can't see any sync button, where will i get it from?
→ ## Answer + fix done

**Why you couldn't find it:** The Sync button was a deliberate *per-project ProjectDetail* feature — line 2870 of `ProjectDetail.tsx` literally says *"The multi-project Workspace screen wires ChatThread into tabs instead."* So Workspace (CodeSpace) — your default landing screen