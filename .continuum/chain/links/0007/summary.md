the queue is not showing when we defocus from chat and get here again.
→ ## Done — fix on `fix/persist-chat-queue`

**Root cause:** `ProjectDetail.tsx` line ~2120 used a plain `React.useState<string[]>([])` for the chat queue. React-Router unmounts ProjectDetail on every navigation (Settings, Costs, Workspace…) → the queue state is destroyed → coming back shows an empty