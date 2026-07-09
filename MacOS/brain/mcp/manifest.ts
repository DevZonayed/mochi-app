// Mochi External MCP — the ACTION MANIFEST.
//
// Every action the app can perform flows through ONE function: `dispatch(method, params)`
// in ../localApi.ts. This manifest exposes that whole surface to an OUTSIDE agent as MCP
// tools (Claude Desktop, Cursor, Codex, Cline, …). Each entry maps 1:1 to a dispatch
// `case`, so the external tool name IS the dispatch method name — "every single action".
//
// Tools are grouped into CATEGORIES (toggled per-category in Settings) and a subset is
// flagged DESTRUCTIVE (irreversible, outward-facing, or shell/filesystem/auth-mutating);
// those stay OFF until the operator flips "Allow destructive actions". The MCP layer
// (../mcp/external-mcp.ts) enforces both gates on tools/list AND tools/call.
//
// CONTRACT ACCURACY: each tool ships a real JSON `inputSchema` (see TOOL_SCHEMAS below)
// whose property names + `required` list are audited 1:1 against what the matching
// dispatch case actually reads off `params`. This is deliberate — a generic MCP client
// (Hermes, Cursor, Claude Desktop) can only call a tool correctly if the advertised
// parameter names match the ones `dispatch` destructures. The names are NOT always the
// "obvious" ones: many project/session/job/asset actions read `p.id` (not `p.projectId`
// / `p.sessionId` / `p.jobId` / `p.assetId`), `sendChat` reads `p.text` (not `p.prompt`),
// `runResearch` reads `p.topic`, `killCommand` reads `p.runId`, and so on. The
// contract-drift regression test (manifest.test.ts) parses localApi.ts and fails if a
// schema's required property is not actually read as `p.<name>` in that case — so these
// stay honest as the dispatch surface evolves.

export type McpCategoryId =
  | 'system' | 'projects' | 'design' | 'sessions' | 'git' | 'jobs'
  | 'schedule' | 'skills' | 'mcp' | 'providers' | 'memory'
  | 'browser' | 'extension' | 'media' | 'research' | 'publishing'
  | 'comms' | 'whatsapp' | 'feedback' | 'files';

/** A JSON-Schema property descriptor (the small subset MCP clients actually use). */
export interface McpProp {
  type?: string | string[];
  description?: string;
  items?: { type: string };
  enum?: readonly (string | number | null)[];
  const?: string | number | boolean | null;
  /** Property-level union (e.g. reviewer = an object OR the literal "off"). */
  anyOf?: McpProp[];
  minLength?: number;
  minItems?: number;
  /** ECMA-262 pattern (unanchored). We use `\S` to require a NONBLANK string. */
  pattern?: string;
  /** For object-typed properties: required keys + nested property shapes (e.g. a
      reviewer role must carry an `engine`). */
  required?: string[];
  properties?: Record<string, McpProp>;
}

/** A composable JSON-Schema fragment used inside top-level anyOf/allOf/not —
    enough to express "at least one of these keys", "canonical OR alias", and
    transport-dependent ("http ⇒ url, else command, but NOT both loopholes")
    contracts. */
export interface McpSubSchema {
  required?: string[];
  properties?: Record<string, McpProp>;
  anyOf?: McpSubSchema[];
  allOf?: McpSubSchema[];
  not?: McpSubSchema;
}

/** The per-tool JSON input schema advertised to an external MCP client. */
export interface McpInputSchema extends McpSubSchema {
  type: 'object';
  properties: Record<string, McpProp>;
  required?: string[];
  /** Kept permissive: dispatch ignores unknown keys, so we never reject a valid extra field. */
  additionalProperties: boolean;
}

export interface McpToolDef {
  /** The dispatch method name — also the MCP tool name exposed to the outside agent. */
  method: string;
  category: McpCategoryId;
  description: string;
  /** Irreversible / outward-facing / shell-filesystem-auth mutating — gated behind allowDestructive. */
  destructive?: boolean;
  /** The accurate input schema for this tool (audited against the dispatch case). */
  inputSchema: McpInputSchema;
}

export interface McpCategoryDef {
  id: McpCategoryId;
  title: string;
  blurb: string;
  /** Whether the category is ON by default when external access is first enabled. */
  defaultOn: boolean;
}

export const MCP_CATEGORIES: McpCategoryDef[] = [
  { id: 'system',     title: 'System & settings',     blurb: 'Health, dashboard, budget/costs, settings, roles, routing, models.', defaultOn: true },
  { id: 'projects',   title: 'Projects',              blurb: 'List / create / open / update / delete projects, repos, folders, memory.', defaultOn: true },
  { id: 'sessions',   title: 'Sessions & chat',       blurb: 'Chat sessions and sending turns to the agent (sendChat).', defaultOn: true },
  { id: 'jobs',       title: 'Jobs & background',     blurb: 'Jobs, background tasks, approvals, agent questions.', defaultOn: true },
  { id: 'git',        title: 'Git & pull requests',   blurb: 'Per-session git status, push, PR create/merge, conflicts.', defaultOn: true },
  { id: 'schedule',   title: 'Schedules & cron',      blurb: 'Recurring/one-shot schedules and scheduled messages.', defaultOn: true },
  { id: 'skills',     title: 'Skills & registry',     blurb: 'Search / install / toggle skills and templates.', defaultOn: true },
  { id: 'mcp',        title: 'Outbound MCP servers',  blurb: 'Manage the MCP servers Mochi itself connects out to.', defaultOn: false },
  { id: 'media',      title: 'Images & media',        blurb: 'Generate/list/regenerate images and media assets.', defaultOn: true },
  { id: 'research',   title: 'Research',              blurb: 'Run research, list briefs and research runs.', defaultOn: true },
  { id: 'publishing', title: 'Publishing',            blurb: 'Drafts, export, publish ledger.', defaultOn: false },
  { id: 'browser',    title: 'Browser',               blurb: "Playwright-backed per-project browser (navigate, screenshot, profiles).", defaultOn: true },
  { id: 'extension',  title: 'Browser extension',     blurb: 'Native Chrome extension control channel.', defaultOn: false },
  { id: 'comms',      title: 'Comms & Telegram',      blurb: 'Telegram connection and chat bindings.', defaultOn: false },
  { id: 'whatsapp',   title: 'WhatsApp',              blurb: 'Read chats/messages, avatars, project bindings, send (destructive).', defaultOn: true },
  { id: 'providers',  title: 'Providers & auth',      blurb: 'Engine installs, provider keys, GitHub / Codex login.', defaultOn: false },
  { id: 'memory',     title: 'Memory sync',           blurb: 'GitHub-backed project memory backup.', defaultOn: true },
  { id: 'design',     title: 'Design comments',       blurb: 'Design→code comments and copy-to-code.', defaultOn: true },
  { id: 'feedback',   title: 'Feedback',              blurb: 'In-app feedback and issue escalation.', defaultOn: false },
  { id: 'files',      title: 'Files & shell',         blurb: 'Read/list files, write files, run/kill commands (destructive).', defaultOn: true },
];

// Compact table: [method, description, destructive?]. Grouped by category. The `description`
// param hints ({…}) are kept in sync with the authoritative TOOL_SCHEMAS below.
type Row = [method: string, description: string, destructive?: boolean];
const GROUPS: Record<McpCategoryId, Row[]> = {
  system: [
    ['health', 'Liveness check of the brain.'],
    ['dashboard', 'The home dashboard payload (greeting projects, gates, active/recent jobs, schedule, budget).'],
    ['budget', 'Budget cap + spend, broken down by project.'],
    ['costs', 'Cost analytics (today / month / by day / project / engine).'],
    ['claudeUsage', 'Claude subscription usage (five-hour + seven-day utilization). Params: {force?}.'],
    ['listEvents', 'The app event log.'],
    ['setBudgetCap', 'Set the monthly budget cap. Params: {cap}.'],
    ['getSettings', 'Read all app settings.'],
    ['setSettings', 'Patch app settings. Params: a partial settings object.'],
    ['listWorkspaces', 'List workspaces.'],
    ['createWorkspace', 'Create a workspace. Params: {name, budgetCap?}.'],
    ['getRoles', 'Read primary/reviewer engine roles.'],
    ['setRoles', 'Set primary/reviewer engine roles. Params: {primaryKey?|primary?, reviewerKey?|reviewer?}.'],
    ['getRouting', 'Read per-purpose model routing.'],
    ['setRouting', 'Set per-purpose model routing. Params: {master?, reviewer?, image?, video?}.'],
    ['getPairing', 'Get the relay pairing code for phone/web remotes.'],
    ['listModels', 'List available models grouped by engine. Params: {refresh?}.'],
    ['listOwners', 'List GitHub owners (personal + orgs) available for repos.'],
    ['checkSlug', 'Validate/normalize a project slug. Params: {name}.'],
  ],
  projects: [
    ['listProjects', 'List all projects.'],
    ['getProject', 'Get one project. Params: {id}.'],
    ['getProjectMemory', 'Read a project\'s agent memory (.continuum). Params: {id}.'],
    ['setProjectMemory', 'Write a project\'s agent memory (.continuum STATE.md). Params: {id, state}.'],
    ['snapshotProject', 'Take a project snapshot. Params: {id, message?}.'],
    ['createProject', 'Create a project. Params: {name, kind?, path?, template?, …}.'],
    ['openProject', 'Open/activate a project (memory lifecycle). Params: {id}.'],
    ['closeProject', 'Close a project (stop the memory watcher). Params: {id}.'],
    ['updateProject', 'Update project fields. Params: {id, …}.'],
    ['reorderProjects', 'Reorder projects. Params: {ids:string[]}.'],
    ['getProjectRepo', 'Get a project\'s git repo info. Params: {id}.'],
    ['githubRepoMetadata', 'Fetch GitHub repo metadata. Params: {owner, repo}.'],
    ['cloneRepo', 'Clone a GitHub repo into a new project. Params: {url, dest, …}.', true],
    ['revealProject', 'Reveal a project folder in Finder. Params: {id}.'],
    ['deleteProject', 'Delete a project. Params: {id}.', true],
    ['bootstrapProject', 'Bootstrap a GitHub-first project (creates code+memory repos). Params: {name, localPath, …}.'],
    ['adoptFolderInspect', 'Inspect a folder before adopting it as a project. Params: {path}.'],
    ['browseDir', 'Browse a directory (file picker backend). Params: {path?}.'],
    ['inspectFolder', 'Inspect a folder\'s contents. Params: {path}.'],
    ['gitAvailable', 'Whether git is available on this machine.'],
  ],
  design: [
    ['listDesignComments', 'List design comments. Params: {id}.'],
    ['addDesignComment', 'Add a design comment. Params: {id, selector?, label?, note?}.'],
    ['setDesignCommentStatus', 'Set a design comment status. Params: {id, commentId, status}.'],
    ['deleteDesignComment', 'Delete a design comment. Params: {id, commentId}.', true],
    ['copyDesignToCode', 'Copy a design artifact into a new coding project. Params: {id, name?}.'],
  ],
  sessions: [
    ['listSessions', 'List chat sessions in a project. Params: {projectId?}.'],
    ['listBranches', 'List branches for a project. Params: {projectId}.'],
    ['createSession', 'Create a chat session. Params: {projectId, title?, baseBranch?, …}.'],
    ['renameSession', 'Rename a session. Params: {id, title}.'],
    ['deleteSession', 'Delete a session. Params: {id}.', true],
    ['pinSession', 'Pin/unpin a session. Params: {id, pinned}.'],
    ['archiveSession', 'Archive/unarchive a session. Params: {id, archived}.'],
    ['continueSession', 'Resume/fork a session. Params: {sessionId, baseRefName?, …}.'],
    ['setSessionAutopilot', 'Toggle autopilot for a session. Params: {sessionId|id, enabled|on}.'],
    ['setSessionReviewer', 'Set the reviewer role and/or toggle the reviewer pass. Params: {sessionId|id, reviewer?:{engine,model}|"off", enabled?|on?}.'],
    ['sendChat', 'Send a chat turn to the agent (the main entrypoint). Params: {projectId, text (aka prompt|message), sessionId?, …}.'],
    ['scanConversations', 'Scan external CLI conversation history to import. Params: {projectId}.'],
    ['importConversations', 'Import scanned conversations. Params: {projectId, items}.'],
  ],
  git: [
    ['getSessionGitStatus', 'Read a session\'s git/PR status. Params: {sessionId, withPr?}.'],
    ['refreshSessionGitStatus', 'Force-refresh a session\'s git status. Params: {sessionId}.'],
    ['pushSession', 'Push a session\'s branch to origin. Params: {sessionId}.', true],
    ['createSessionPR', 'Open a PR from a session\'s branch. Params: {sessionId, title?, body?, base?}.', true],
    ['mergeSessionPR', 'Merge a session\'s PR (human-confirmed in UI). Params: {sessionId, method?}.', true],
    ['resolveSession', 'Resolve a session\'s merge conflicts (human-confirmed). Params: {sessionId}.', true],
    ['previewSessionMerge', 'Preview a session merge. Params: {sessionId, method?}.'],
    ['previewSessionResolve', 'Preview a conflict resolution. Params: {sessionId}.'],
    ['getConflictHunks', 'Get conflict hunks for a session. Params: {sessionId}.'],
    ['setConflictResolveHint', 'Set a conflict-resolution hint. Params: {sessionId, hint?}.'],
    ['renameSessionBranch', 'Rename a session\'s branch. Params: {sessionId}.'],
    ['archiveSessionWorktree', 'Archive a session\'s git worktree. Params: {sessionId, deleteBranch?}.', true],
  ],
  jobs: [
    ['listJobs', 'List jobs. Params: {projectId?, sessionId?}.'],
    ['listJobPage', 'List a page of jobs. Params: {projectId?, sessionId?, cursor?, limit?}.'],
    ['getJob', 'Get one job. Params: {id}.'],
    ['getJobDiff', 'Get a job\'s diff. Params: {id}.'],
    ['createJob', 'Create a job (not run). Params: {projectId, input, …}.'],
    ['runJob', 'Run an existing job. Params: {id}.'],
    ['cancelJob', 'Cancel a running job. Params: {id}.'],
    ['steerJob', 'Inject a steering message into a running job. Params: {id, text}.'],
    ['deleteJob', 'Delete a job. Params: {id}.', true],
    ['createAndRunJob', 'Create and immediately run a job. Params: {projectId, input, …}.'],
    ['listBgTasks', 'List background tasks. Params: {projectId?}.'],
    ['bgOutput', 'Read a background task\'s output. Params: {id, tailKB?}.'],
    ['stopBgTask', 'Stop a background task. Params: {id}.', true],
    ['listApprovals', 'List pending tool-use approvals. Params: {status?}.'],
    ['approveApproval', 'Approve a pending tool-use gate. Params: {id}.'],
    ['denyApproval', 'Deny a pending tool-use gate. Params: {id}.'],
    ['answerQuestion', 'Answer an agent AskUserQuestion. Params: {sessionId, answer}.'],
    ['extendQuestion', 'Extend an agent question\'s deadline. Params: {sessionId}.'],
  ],
  schedule: [
    ['listSchedules', 'List schedules.'],
    ['createSchedule', 'Create a schedule / queued message. Params: {title, projectId?, sessionId?, prompt?, fireAt?, cadence?, …}.'],
    ['toggleSchedule', 'Enable/disable a schedule. Params: {id, enabled}.'],
    ['updateSchedule', 'Edit a schedule. Params: {id, …}.'],
    ['deleteSchedule', 'Delete a schedule. Params: {id}.', true],
    ['scheduleCheck', 'Schedule a wait-&-check follow-up that pokes a chat after delayMs. Params: {delayMs, sessionId?, …}.'],
    ['scheduleMessage', 'Schedule a one-shot message into a session. Params: {fireAt, prompt, sessionId?, …}.'],
  ],
  skills: [
    ['listSkills', 'List registry/known skills.'],
    ['toggleSkill', 'Enable/disable a skill (toggles state). Params: {id}.'],
    ['listTemplates', 'List project templates.'],
    ['searchSkills', 'Search the skill registry. Params: {q, limit?}.'],
    ['skillRegistryMeta', 'Get registry metadata.'],
    ['registryGetSkill', 'Get one registry skill. Params: {id}.'],
    ['registrySkillContent', 'Get a registry skill\'s SKILL.md content. Params: {id}.'],
    ['listProjectSkills', 'List skills installed in a project. Params: {id}.'],
    ['addSkillToProject', 'Install a skill into a project. Params: {projectId, skillId}.'],
    ['setProjectSkillEnabled', 'Enable/disable an installed project skill. Params: {projectId, skillId, enabled}.'],
    ['removeSkillFromProject', 'Remove an installed project skill. Params: {projectId, skillId}.', true],
  ],
  mcp: [
    ['listMcpServers', 'List operator-configured (outbound) MCP servers.'],
    ['addMcpServer', 'Add an outbound MCP server. Params: {name, transport, command?|url?, …}.'],
    ['updateMcpServer', 'Update an outbound MCP server. Params: {id, name, transport, …}.'],
    ['setMcpServerEnabled', 'Enable/disable an outbound MCP server. Params: {id, enabled}.'],
    ['removeMcpServer', 'Remove an outbound MCP server. Params: {id}.', true],
  ],
  providers: [
    ['listProviders', 'List connected providers / API keys.'],
    ['connectProvider', 'Connect a provider / store an API key. Params: {provider, apiKey}.', true],
    ['disconnectProvider', 'Disconnect a provider. Params: {provider}.', true],
    ['codexLogin', 'Start Codex (ChatGPT) login.'],
    ['codexLoginCancel', 'Cancel a Codex login.'],
    ['codexLogout', 'Sign out of Codex.', true],
    ['enginesStatus', 'Status of all engine binaries.'],
    ['installEngine', 'Download/install an engine binary. Params: {engine}.', true],
    ['cancelEngineInstall', 'Cancel an engine install. Params: {engine}.'],
    ['engineStatus', 'Engine status snapshot (the single source of truth).'],
    ['githubStatus', 'GitHub auth status.'],
    ['listGithubOwners', 'List GitHub owners (personal + orgs).'],
    ['githubLogin', 'Start GitHub device-flow login.'],
    ['githubLoginCancel', 'Cancel a GitHub login.'],
    ['githubLogout', 'Sign out of GitHub.', true],
    ['ghCliState', 'State of the bundled gh CLI.'],
  ],
  memory: [
    ['memorySyncStatus', 'Memory-repository sync status.'],
    ['memorySyncNow', 'Force a memory-repository sync now. Params: {projectId?}.'],
  ],
  browser: [
    ['browserOpen', 'Open the per-project browser. Params: {projectId, startUrl?}.'],
    ['browserClose', 'Close the per-project browser. Params: {projectId}.'],
    ['browserNavigate', 'Navigate the browser. Params: {projectId, url}.'],
    ['browserStatus', 'Browser status. Params: {projectId?}.'],
    ['browserScreenshot', 'Screenshot the browser. Params: {projectId, fullPage?}.'],
    ['browserListComments', 'List browser design comments. Params: {projectId}.'],
    ['browserClearData', 'Clear the browser profile data. Params: {projectId}.', true],
    ['browserRevealProfile', 'Reveal the browser profile folder. Params: {projectId}.'],
    ['browserListChromeProfiles', 'List installed Chrome profiles.'],
    ['browserChromeStatus', 'Whether Chrome is installed/detected.'],
    ['browserInstallChrome', 'Install Chrome for automation.', true],
    ['browserImportSeed', 'Import a Chrome profile seed (cookies/storage). Params: {profileDir, sourceName?, quitChrome?}.'],
    ['browserSeedInfo', 'Inspect the imported Chrome profile seed.'],
    ['browserClearSeed', 'Clear the imported browser seed.', true],
  ],
  extension: [
    ['extensionStatus', 'Native browser-extension bridge status.'],
    ['extensionSetActive', 'Set the active extension peer. Params: {clientId}.'],
    ['extensionBrowserOpen', 'Open the user\'s real Chrome via the extension. Params: {url?}.'],
    ['extensionBrowserClose', 'Close the extension-driven browser.'],
    ['extensionPath', 'Path to the bundled extension.'],
    ['extensionRevealFolder', 'Reveal the extension folder in Finder.'],
  ],
  media: [
    ['mediaRates', 'Media generation model rates.'],
    ['listAssets', 'List media assets. Params: {projectId?, status?}.'],
    ['getAsset', 'Get one asset. Params: {id}.'],
    ['generateAsset', 'Generate a media asset (image/audio/video/music). Params: {modelKey, prompt, projectId?, …}.'],
    ['regenerateImage', 'Regenerate/edit an image asset. Params: {assetId, instruction?, …}.'],
    ['cancelAsset', 'Cancel a generating asset. Params: {id}.'],
    ['deleteAsset', 'Delete an asset. Params: {id}.', true],
    ['approveAsset', 'Approve an asset. Params: {id}.'],
    ['importAsset', 'Import a file as an asset. Params: {path, projectId?}.'],
    ['assetImage', 'Read an asset image (bytes/data-url). Params: {assetId}.'],
  ],
  research: [
    ['runResearch', 'Run a research task. Params: {topic}.'],
    ['listBriefs', 'List research briefs.'],
    ['listResearchRuns', 'List research runs.'],
    ['markBriefSent', 'Mark a research brief as sent. Params: {id}.'],
  ],
  publishing: [
    ['listPublishDrafts', 'List publish drafts.'],
    ['listPublishLedger', 'List the publish ledger.'],
    ['createDraft', 'Create a publish draft. Params: {assetId, caption?, platforms?}.'],
    ['updateDraft', 'Update a publish draft. Params: {id, …}.'],
    ['deleteDraft', 'Delete a publish draft. Params: {id}.', true],
    ['scheduleDraft', 'Schedule a publish draft. Params: {id, scheduledAt}.', true],
    ['exportDraft', 'Export a publish draft. Params: {id}.', true],
    ['markPublished', 'Mark a draft as published. Params: {id}.', true],
  ],
  comms: [
    ['commsStatus', 'Telegram/comms status.'],
    ['listChatBindings', 'List project↔chat bindings.'],
    ['listPendingChats', 'List unbound inbound chats.'],
    ['listCommEvents', 'List comms events.'],
    ['connectTelegram', 'Connect a Telegram bot. Params: {token}.', true],
    ['disconnectTelegram', 'Disconnect Telegram.', true],
    ['bindChat', 'Bind a chat to a project. Params: {chatId, projectId?, …}.'],
    ['unbindChat', 'Unbind a chat. Params: {chatId}.'],
    ['setChatPermissions', 'Set a bound chat\'s permissions. Params: {chatId, permissions}.'],
  ],
  whatsapp: [
    ['whatsappStatus', 'WhatsApp connection status.'],
    ['whatsappLink', 'Begin linking WhatsApp (returns pairing state). Params: {phone?}.'],
    ['whatsappQr', 'Get the current WhatsApp link QR.'],
    ['disconnectWhatsApp', 'Disconnect the WhatsApp socket.', true],
    ['unlinkWhatsApp', 'Unlink WhatsApp entirely.', true],
    ['listWaChats', 'List WhatsApp chats.'],
    ['waListChats', 'List WhatsApp chats (alias).'],
    ['waGetMessages', 'Read messages from a WhatsApp chat. Params: {chatId, limit?, before?}.'],
    ['waChatInfo', 'Info about a WhatsApp chat. Params: {chatId}.'],
    ['waSendText', 'Send a WhatsApp text message. Params: {chatId, text}.', true],
    ['waSendMedia', 'Send WhatsApp media. Params: {chatId, path?|dataB64?, kind?, caption?}.', true],
    ['waReact', 'React to a WhatsApp message. Params: {chatId, msgId, emoji}.', true],
    ['waMarkRead', 'Mark a WhatsApp chat as read. Params: {chatId}.'],
    ['waSetTyping', 'Set typing state in a WhatsApp chat. Params: {chatId, on?}.', true],
    ['waFetchAvatar', 'Fetch a WhatsApp contact avatar. Params: {chatId}.'],
    ['waDownloadMedia', 'Download a WhatsApp media message. Params: {chatId, msgId}.'],
    ['approveWhatsappSend', 'Approve the gated WhatsApp send.'],
    ['setWhatsappAgentSend', 'Toggle whether the agent may send to non-own numbers. Params: {on}.', true],
    ['setWhatsappRecipient', 'Set the personal WhatsApp recipient number. Params: {number}.'],
    ['listProjectWaChats', 'List WhatsApp chats bound to a project. Params: {projectId}.'],
    ['addProjectWaChat', 'Bind a WhatsApp chat to a project. Params: {projectId, chatId}.'],
    ['removeProjectWaChat', 'Unbind a WhatsApp chat from a project. Params: {projectId, chatId}.', true],
  ],
  feedback: [
    ['listFeedback', 'List in-app feedback.'],
    ['submitFeedback', 'Submit feedback. Params: {message, category?, source?}.'],
    ['updateFeedback', 'Update a feedback item. Params: {id, status?}.'],
    ['deleteFeedback', 'Delete a feedback item. Params: {id}.', true],
    ['feedbackCreateIssue', 'Escalate feedback to a GitHub issue. Params: {id, repo?}.', true],
  ],
  files: [
    ['revealPath', 'Reveal a path in Finder. Params: {path}.'],
    ['readFile', 'Read a file (path-confined to project roots). Params: {path, sessionId?, projectId?}.'],
    ['listDir', 'List a directory (path-confined). Params: {path, sessionId?, projectId?}.'],
    ['listProjectFiles', 'List a project\'s files. Params: {projectId}.'],
    ['writeFile', 'Overwrite a file (path-confined). Params: {path, text, sessionId?, projectId?}.', true],
    ['runCommand', 'Run a shell command in a project folder (path-confined). Params: {projectId, command}.', true],
    ['killCommand', 'Kill a running command. Params: {runId}.', true],
  ],
};

/* ── Schema builders ───────────────────────────────────────────────────────
   Kept tiny + explicit. `additionalProperties: true` everywhere — dispatch
   silently ignores unknown keys, so we document the known contract without
   ever rejecting a caller who sends a valid-but-undocumented extra field. */
const S = (
  properties: Record<string, McpProp> = {},
  required: string[] = [],
  extra: { anyOf?: McpSubSchema[]; allOf?: McpSubSchema[] } = {},
): McpInputSchema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  ...(extra.anyOf ? { anyOf: extra.anyOf } : {}),
  ...(extra.allOf ? { allOf: extra.allOf } : {}),
  additionalProperties: true,
});
const str = (description?: string): McpProp => ({ type: 'string', ...(description ? { description } : {}) });
/** A NONBLANK string (must contain a non-whitespace char) — mirrors dispatch's
    `String(x).trim()` truthiness checks. `\S` is an unanchored "contains" match. */
const nbstr = (description?: string): McpProp => ({ type: 'string', pattern: '\\S', ...(description ? { description } : {}) });
const num = (description?: string): McpProp => ({ type: 'number', ...(description ? { description } : {}) });
const numOrNull = (description?: string): McpProp => ({ type: ['number', 'null'], ...(description ? { description } : {}) });
const bool = (description?: string): McpProp => ({ type: 'boolean', ...(description ? { description } : {}) });
const strList = (description?: string): McpProp => ({ type: 'array', items: { type: 'string' }, ...(description ? { description } : {}) });
const objList = (description?: string): McpProp => ({ type: 'array', ...(description ? { description } : {}) });
const obj = (description?: string): McpProp => ({ type: 'object', ...(description ? { description } : {}) });
const enumStr = (values: readonly string[], description?: string): McpProp => ({ type: 'string', enum: values, ...(description ? { description } : {}) });
/** A reviewer value: a role OBJECT that carries an `engine` (a bare `{}` is not a
    valid role), OR the literal string "off". Matches dispatch, which rejects an
    object with no known engine. */
const objOrOff = (description?: string): McpProp => ({
  anyOf: [
    { type: 'object', required: ['engine'], properties: { engine: { type: 'string' } } },
    { const: 'off' },
  ],
  ...(description ? { description } : {}),
});

/** "At least one of these keys is present" — the shape both alias groups
    (canonical OR alias) and payload groups (text|images|files) reduce to. */
const oneOf = (...names: string[]): McpSubSchema => ({ anyOf: names.map((n) => ({ required: [n] })) });
/** Like oneOf, but each alternative also requires its key to be a NONBLANK
    string — so an empty/whitespace value doesn't satisfy the "at least one"
    contract (mirrors dispatch's truthiness/trim checks). */
const oneOfNonblank = (...names: string[]): McpSubSchema => ({
  anyOf: names.map((n) => ({ required: [n], properties: { [n]: nbstr() } })),
});

/** normalizeMcpInput(): transport defaults to 'stdio'; stdio needs a nonblank
    `command`, http needs a nonblank `url`. Honest, loophole-free branches:
      - HTTP: transport === 'http' AND a (nonblank) url — a stray `command`
        can NEVER stand in for the missing url,
      - stdio: a (nonblank) command AND the request is NOT the http transport
        (transport is 'stdio' or omitted).
    `url`/`command` nonblank-ness is enforced on the tool's top-level props.
    Shared by addMcpServer + updateMcpServer (both funnel through normalizeMcpInput). */
const MCP_TRANSPORT_ANYOF: McpSubSchema[] = [
  { properties: { transport: { const: 'http' } }, required: ['transport', 'url'] },
  { required: ['command'], not: { required: ['transport'], properties: { transport: { const: 'http' } } } },
];

const PASSTHROUGH_SCHEMA: McpInputSchema = { type: 'object', properties: {}, additionalProperties: true };

/** Methods whose params are validated inside a shared helper (normalizeMcpInput),
    not the case block itself — exempt from the literal `p.<name>` drift check. */
export const SCHEMA_DRIFT_EXEMPT: ReadonlySet<string> = new Set(['addMcpServer', 'updateMcpServer']);

/**
 * Authoritative per-tool input schemas. Property names + `required` are audited
 * against what each dispatch case in ../localApi.ts actually reads off `params`.
 * Every method in GROUPS MUST appear here (asserted by manifest.test.ts).
 */
export const TOOL_SCHEMAS: Record<string, McpInputSchema> = {
  // ── system ──────────────────────────────────────────────────────────────
  health: S(),
  dashboard: S(),
  budget: S(),
  costs: S(),
  claudeUsage: S({ force: bool('Re-fetch instead of returning the cached value.') }),
  listEvents: S(),
  setBudgetCap: S({ cap: num('Monthly budget cap (positive number).') }, ['cap']),
  getSettings: S(),
  setSettings: S({
    defaultEffort: enumStr(['fast', 'balanced', 'deep', 'max']),
    defaultEngine: enumStr(['auto', 'claude', 'codex']),
    openAtLogin: bool(),
    rescanCadence: enumStr(['daily', 'weekly', 'onchange']),
    favoriteModels: strList(),
    feedbackRepo: str('owner/repo for feedback issues ("" clears).'),
    autoCreateRepo: bool(),
    autoPushCommits: bool(),
    memorySyncEnabled: bool(),
    memoryRepoOwner: str('"" = personal profile, else an org login.'),
    memoryRepoName: str(),
    browser: obj('Browser sub-settings (enabled/headless/chromePath/…).'),
  }),
  listWorkspaces: S(),
  createWorkspace: S({ name: str('Workspace name.'), budgetCap: num('Monthly cap (default 200).') }, ['name']),
  getRoles: S(),
  setRoles: S({
    primaryKey: str('Picker key for the primary model (or use `primary`).'),
    primary: obj('{engine, model} for the primary role.'),
    reviewerKey: str('Picker key for the reviewer model, or "off".'),
    reviewer: objOrOff('{engine, model} for the reviewer role, OR the literal "off".'),
  }),
  getRouting: S(),
  setRouting: S({
    master: str('Engine for the master/primary role.'),
    reviewer: str('Engine for the reviewer role, or "off".'),
    image: str('Engine for image generation.'),
    video: str('Engine for video generation.'),
  }),
  getPairing: S(),
  listModels: S({ refresh: bool('Force a provider catalog refresh.') }),
  listOwners: S(),
  checkSlug: S({ name: str('Project name to slugify + check availability for.') }, ['name']),

  // ── projects ────────────────────────────────────────────────────────────
  listProjects: S(),
  getProject: S({ id: str('Project id.') }, ['id']),
  getProjectMemory: S({ id: str('Project id.') }, ['id']),
  setProjectMemory: S({ id: str('Project id.'), state: str('New .continuum STATE.md contents.') }, ['id']),
  snapshotProject: S({ id: str('Project id.'), message: str('Snapshot commit message.') }, ['id']),
  createProject: S({
    name: str('Project name.'),
    kind: enumStr(['coding', 'design', 'content', 'research', 'general', 'context']),
    path: str('Existing folder to use (optional).'),
    template: str(),
    instructions: str(),
    color: str(),
    repoUrl: str('Existing git remote to attach.'),
    memorySlug: str(),
    memoryRepoUrl: str(),
    designMode: enumStr(['raw', 'redesign'], 'For design projects: guided-workflow mode.'),
    designBrief: str(),
  }, ['name']),
  openProject: S({ id: str('Project id to open/activate.') }, ['id']),
  closeProject: S({ id: str('Project id to close.') }, ['id']),
  updateProject: S({
    id: str('Project id.'),
    name: str(), instructions: str(), color: str(), template: str(), path: str(),
    repoUrl: str(), defaultBaseBranch: str(), setupScript: str(), memorySlug: str(), memoryRepoUrl: str(),
    kind: enumStr(['coding', 'design', 'content', 'research', 'general', 'context']),
    linkedProjectIds: strList('For context projects: connected project ids.'),
    copyGlobs: strList('Worktree files-to-copy globs.'),
    runMode: enumStr(['concurrent', 'nonconcurrent']),
    hidden: bool('Soft-hide from the Projects view.'),
    designFlow: enumStr(['direct', 'advanced']),
    designPhase: enumStr(['research', 'brand', 'choice', 'design', 'complete']),
  }, ['id']),
  reorderProjects: S({ ids: strList('Project ids in the desired order.') }, ['ids']),
  getProjectRepo: S({ id: str('Project id.') }, ['id']),
  githubRepoMetadata: S({ owner: str('GitHub owner/login.'), repo: str('Repository name.') }, ['owner', 'repo']),
  cloneRepo: S({
    url: str('Git clone URL.'),
    dest: str('Destination parent folder.'),
    dirName: str('Optional target directory name.'),
    name: str('Project name (defaults to repo name).'),
    instructions: str(), color: str(),
  }, ['url', 'dest']),
  revealProject: S({ id: str('Project id.') }, ['id']),
  deleteProject: S({ id: str('Project id.') }, ['id']),
  bootstrapProject: S({
    name: str('Project name.'),
    localPath: str('Local folder for the project.'),
    private: bool('Create the repo private (default true).'),
    owner: obj('{login, kind:"user"|"org"} — dual-repo owner selection.'),
    description: str(),
    adopt: bool(), skipInit: bool(), remoteOnly: bool(),
  }, ['name', 'localPath']),
  adoptFolderInspect: S({ path: str('Folder to classify for the adopt flow.') }, ['path']),
  browseDir: S({ path: str('Directory to browse (defaults to home).') }),
  inspectFolder: S({ path: str('Folder to inspect.') }, ['path']),
  gitAvailable: S(),

  // ── design ──────────────────────────────────────────────────────────────
  listDesignComments: S({ id: str('Project id.') }, ['id']),
  addDesignComment: S({
    id: str('Project id.'), selector: str('CSS selector / element ref.'), label: str(), note: str(),
  }, ['id']),
  setDesignCommentStatus: S({
    id: str('Project id.'), commentId: str('Comment id.'), status: enumStr(['open', 'resolved']),
  }, ['id', 'commentId', 'status']),
  deleteDesignComment: S({ id: str('Project id.'), commentId: str('Comment id.') }, ['id', 'commentId']),
  copyDesignToCode: S({ id: str('Design project id.'), name: str('Name for the new coding project.') }, ['id']),

  // ── sessions ────────────────────────────────────────────────────────────
  listSessions: S({ projectId: str('Filter to one project (optional).') }),
  listBranches: S({ projectId: str('Project id.') }, ['projectId']),
  createSession: S({
    projectId: str('Project id.'), title: str('Session title.'), codename: str(),
    baseBranch: str('Branch to fork the worktree from.'), base: str('Alias of baseBranch.'),
  }, ['projectId']),
  renameSession: S({ id: str('Session id (sessionId also accepted).'), sessionId: str('Alias of id.'), title: str('New title.') }, ['title'], oneOf('id', 'sessionId')),
  deleteSession: S({ id: str('Session id (sessionId also accepted).'), sessionId: str('Alias of id.') }, [], oneOf('id', 'sessionId')),
  pinSession: S({ id: str('Session id (sessionId also accepted).'), sessionId: str('Alias of id.'), pinned: bool('Pin (true) or unpin (false).') }, ['pinned'], oneOf('id', 'sessionId')),
  archiveSession: S({ id: str('Session id (sessionId also accepted).'), sessionId: str('Alias of id.'), archived: bool('Archive (true) or unarchive (false).') }, ['archived'], oneOf('id', 'sessionId')),
  continueSession: S({
    sessionId: str('Session id to fork from (id also accepted).'),
    id: str('Alias of sessionId.'),
    baseRefName: str('Base ref for the new session.'),
    prNumber: num(), mergedAt: num(),
  }, [], oneOf('sessionId', 'id')),
  // Autopilot: session id via sessionId|id; the desired state via enabled|on.
  setSessionAutopilot: S(
    { sessionId: str('Session id (id also accepted).'), id: str('Alias of sessionId.'), enabled: bool('Autopilot on/off.'), on: bool('Alias of enabled.') },
    [],
    { allOf: [oneOf('sessionId', 'id'), oneOf('enabled', 'on')] },
  ),
  // Reviewer: session id via sessionId|id; supply a reviewer ROLE ({engine, model}
  // or the literal "off"), and/or the boolean pass toggle (enabled|on).
  setSessionReviewer: S(
    {
      sessionId: str('Session id (id also accepted).'), id: str('Alias of sessionId.'),
      reviewer: objOrOff('{engine, model} reviewer role, OR the literal "off".'),
      enabled: bool('Run the reviewer pass every turn.'), on: bool('Alias of enabled.'),
    },
    [],
    { allOf: [oneOf('sessionId', 'id'), oneOf('reviewer', 'enabled', 'on')] },
  ),
  sendChat: S({
    projectId: str('Project id (required).'),
    text: str('The message text to send to the agent (the prompt). Aliases: prompt, message.'),
    prompt: str('Alias of text.'), message: str('Alias of text.'),
    sessionId: str('Existing session id — omit to lazy-create/route to the primary session.'),
    images: objList('Pasted/dropped images: [{id?, dataB64, mime?, name?}].'),
    files: objList('Attachments: [{id?, name?, mime?, kind?, content?, dataB64?}].'),
    baseBranch: str('Base branch for a newly created session.'), base: str('Alias of baseBranch.'),
    modelKey: str('Picker key for the primary model.'), engine: str(), model: str(),
    reviewerKey: str('Picker key for the reviewer model, or "off".'),
    effort: enumStr(['fast', 'balanced', 'deep', 'max']),
    plan: bool('Plan mode.'), goal: bool('Goal mode.'), browser: bool('Grant browser tools.'),
    agentContext: str('Hidden context delivered to the model but not shown in transcript.'),
  }, ['projectId'], {
    // dispatch: projectId AND (NONBLANK text|prompt|message OR >=1 image OR >=1
    // file). Whitespace-only text is trimmed away by dispatch, so `\S` (nonblank)
    // is the honest rule; prompt/message are accepted aliases for text.
    anyOf: [
      { required: ['text'], properties: { text: nbstr() } },
      { required: ['prompt'], properties: { prompt: nbstr() } },
      { required: ['message'], properties: { message: nbstr() } },
      { required: ['images'], properties: { images: { type: 'array', minItems: 1 } } },
      { required: ['files'], properties: { files: { type: 'array', minItems: 1 } } },
    ],
  }),
  scanConversations: S({ projectId: str('Project id.') }, ['projectId']),
  importConversations: S({
    projectId: str('Project id.'),
    items: objList('Scanned conversations: [{source, externalId, filePath?, title?, …}].'),
  }, ['projectId', 'items']),

  // ── git ─────────────────────────────────────────────────────────────────
  // All git session tools accept the canonical `sessionId` OR the `id` alias.
  getSessionGitStatus: S({ sessionId: str('Session id (id also accepted).'), id: str('Alias of sessionId.'), withPr: bool('Include live PR status (default true).') }, [], oneOf('sessionId', 'id')),
  refreshSessionGitStatus: S({ sessionId: str('Session id (id also accepted).'), id: str('Alias of sessionId.') }, [], oneOf('sessionId', 'id')),
  // Destructive/irreversible PR actions: canonical `sessionId` ONLY (no `id`
  // alias) — we don't broaden the param surface of outward-facing operations.
  pushSession: S({ sessionId: str('Session id.') }, ['sessionId']),
  createSessionPR: S({
    sessionId: str('Session id.'), title: str('PR title.'), body: str('PR body.'), base: str('Base branch.'),
  }, ['sessionId']),
  mergeSessionPR: S({ sessionId: str('Session id.'), method: enumStr(['merge', 'squash', 'rebase']) }, ['sessionId']),
  resolveSession: S({ sessionId: str('Session id.') }, ['sessionId']),
  previewSessionMerge: S({ sessionId: str('Session id (id also accepted).'), id: str('Alias of sessionId.'), method: enumStr(['merge', 'squash', 'rebase']) }, [], oneOf('sessionId', 'id')),
  previewSessionResolve: S({ sessionId: str('Session id (id also accepted).'), id: str('Alias of sessionId.') }, [], oneOf('sessionId', 'id')),
  getConflictHunks: S({ sessionId: str('Session id (id also accepted).'), id: str('Alias of sessionId.') }, [], oneOf('sessionId', 'id')),
  setConflictResolveHint: S({ sessionId: str('Session id (id also accepted).'), id: str('Alias of sessionId.'), hint: str('Additional resolve instructions ("" clears).') }, [], oneOf('sessionId', 'id')),
  renameSessionBranch: S({ sessionId: str('Session id (id also accepted).'), id: str('Alias of sessionId.') }, [], oneOf('sessionId', 'id')),
  archiveSessionWorktree: S({ sessionId: str('Session id (id also accepted).'), id: str('Alias of sessionId.'), deleteBranch: bool('Also delete the branch.') }, [], oneOf('sessionId', 'id')),

  // ── jobs ────────────────────────────────────────────────────────────────
  listJobs: S({ projectId: str(), sessionId: str() }),
  listJobPage: S({ projectId: str(), sessionId: str(), before: num(), cursor: str(), limit: num() }),
  getJob: S({ id: str('Job id.') }, ['id']),
  getJobDiff: S({ id: str('Job id (jobId also accepted).'), jobId: str('Alias of id.') }, [], oneOf('id', 'jobId')),
  createJob: S({
    projectId: str('Project id.'), input: str('The job prompt/input.'), title: str(),
    effort: enumStr(['fast', 'balanced', 'deep', 'max']),
  }, ['projectId', 'input']),
  runJob: S({ id: str('Job id.'), effort: enumStr(['fast', 'balanced', 'deep', 'max']), engine: str(), model: str() }, ['id']),
  cancelJob: S({ id: str('Job id.') }, ['id']),
  steerJob: S({ id: str('Job id.'), text: str('Steering message.'), interrupt: bool('Interrupt now (default) vs queue at next boundary.') }, ['id', 'text']),
  deleteJob: S({ id: str('Job id.') }, ['id']),
  createAndRunJob: S({
    projectId: str('Project id.'), input: str('The job prompt/input.'), title: str(),
    effort: enumStr(['fast', 'balanced', 'deep', 'max']), engine: str(), model: str(),
  }, ['projectId', 'input']),
  listBgTasks: S({ projectId: str('Filter to one project (optional).') }),
  bgOutput: S({ id: str('Background task id.'), tailKB: num('Tail size in KB.') }, ['id']),
  stopBgTask: S({ id: str('Background task id.') }, ['id']),
  listApprovals: S({ status: str('Filter by approval status (optional).') }),
  approveApproval: S({ id: str('Approval id.') }, ['id']),
  denyApproval: S({ id: str('Approval id.') }, ['id']),
  answerQuestion: S({ sessionId: str('Session id the question belongs to (id also accepted).'), id: str('Alias of sessionId.'), answer: str('The chosen answer text.') }, ['answer'], oneOf('sessionId', 'id')),
  extendQuestion: S({ sessionId: str('Session id whose question countdown to extend (id also accepted).'), id: str('Alias of sessionId.') }, [], oneOf('sessionId', 'id')),

  // ── schedule ────────────────────────────────────────────────────────────
  listSchedules: S(),
  createSchedule: S({
    title: str('Schedule title (required).'),
    projectId: str(), sessionId: str(),
    prompt: str('Message to deliver (for queued messages).'),
    time: str(), cadence: str(),
    fireAt: num('One-shot fire time (ms epoch).'),
    everyMinutes: num('Recurring interval in minutes.'),
    catchUp: bool(),
    effort: enumStr(['fast', 'balanced', 'deep', 'max']),
    browser: bool(), plan: bool(),
  }, ['title']),
  toggleSchedule: S({ id: str('Schedule id.'), enabled: bool('Enable/disable.') }, ['id', 'enabled']),
  updateSchedule: S({
    id: str('Schedule id.'),
    title: str(), prompt: str(), time: str(), cadence: str(), everyMinutes: num(),
    catchUp: bool(), enabled: bool(), effort: str(), browser: bool(), plan: bool(), sessionId: str(), projectId: str(),
  }, ['id']),
  deleteSchedule: S({ id: str('Schedule id.') }, ['id']),
  scheduleCheck: S({
    delayMs: num('Delay before the check fires (ms, >= 30000).'),
    sessionId: str(), projectId: str(), prompt: str('Check prompt (defaults to a resume nudge).'),
  }, ['delayMs']),
  scheduleMessage: S({
    fireAt: num('Absolute fire time (ms epoch, >= 30s ahead).'),
    prompt: str('Message text to send.'),
    sessionId: str(), projectId: str(),
    effort: enumStr(['fast', 'balanced', 'deep', 'max']), browser: bool(), plan: bool(), goal: bool(),
  }, ['fireAt', 'prompt']),

  // ── skills ──────────────────────────────────────────────────────────────
  listSkills: S(),
  toggleSkill: S({ id: str('Skill id to toggle enabled/disabled.') }, ['id']),
  listTemplates: S(),
  searchSkills: S({ q: str('Search query.'), limit: num('Max results (default 30).') }, ['q']),
  skillRegistryMeta: S(),
  registryGetSkill: S({ id: str('Registry skill id (skillId also accepted).'), skillId: str('Alias of id.') }, [], oneOf('id', 'skillId')),
  registrySkillContent: S({ id: str('Registry skill id (skillId also accepted).'), skillId: str('Alias of id.') }, [], oneOf('id', 'skillId')),
  listProjectSkills: S({ id: str('Project id.') }, ['id']),
  addSkillToProject: S({
    projectId: str('Project id (id also accepted).'), id: str('Alias of projectId.'),
    skillId: str('Registry skill id to install.'),
    name: str(), description: str(), risk: str(), source: str(), version: str(), via: str('"agent" or "operator" (who installed it).'),
    disabledReason: str('If pre-disabled, why (e.g. a failed audit).'),
    mirrorRepo: str('Upstream mirror repo the skill came from.'),
    auditStatus: str('Security-audit status recorded for the skill.'),
  }, ['skillId'], oneOf('projectId', 'id')),
  setProjectSkillEnabled: S({
    projectId: str('Project id (id also accepted).'), id: str('Alias of projectId.'),
    skillId: str('Skill id or slug (slug also accepted).'), slug: str('Alias of skillId.'),
    enabled: bool('Enable/disable.'),
  }, ['enabled'], { allOf: [oneOf('projectId', 'id'), oneOf('skillId', 'slug')] }),
  removeSkillFromProject: S({
    projectId: str('Project id (id also accepted).'), id: str('Alias of projectId.'),
    skillId: str('Skill id or slug.'), slug: str('Alias of skillId.'),
  }, [], { allOf: [oneOf('projectId', 'id'), oneOf('skillId', 'slug')] }),

  // ── mcp (outbound servers) — validated in normalizeMcpInput (drift-exempt) ─
  listMcpServers: S(),
  addMcpServer: S({
    name: str('Server name (required).'),
    transport: enumStr(['stdio', 'http'], 'Transport (default stdio).'),
    enabled: bool(),
    command: nbstr('Executable — required (nonblank) for stdio.'), args: strList(), env: objList(), envPassthrough: strList(), cwd: str(),
    url: nbstr('Endpoint — required (nonblank) for http.'), bearerTokenEnv: str(), headers: objList(), headerEnv: objList(),
    skillIds: strList(),
  }, ['name'], { anyOf: MCP_TRANSPORT_ANYOF }),
  updateMcpServer: S({
    id: str('Server id (required).'),
    name: str('Server name (required).'),
    transport: enumStr(['stdio', 'http']),
    enabled: bool(),
    command: nbstr('Executable — required (nonblank) for stdio.'), args: strList(), env: objList(), envPassthrough: strList(), cwd: str(),
    url: nbstr('Endpoint — required (nonblank) for http.'), bearerTokenEnv: str(), headers: objList(), headerEnv: objList(),
    skillIds: strList(),
  }, ['id', 'name'], { anyOf: MCP_TRANSPORT_ANYOF }),
  setMcpServerEnabled: S({ id: str('Server id.'), enabled: bool('Enable/disable.') }, ['id', 'enabled']),
  removeMcpServer: S({ id: str('Server id.') }, ['id']),

  // ── providers ───────────────────────────────────────────────────────────
  listProviders: S(),
  connectProvider: S({
    provider: enumStr(['anthropic', 'openai', 'fal'], 'Provider to connect.'),
    apiKey: str('The API key to store.'),
  }, ['provider', 'apiKey']),
  disconnectProvider: S({ provider: enumStr(['anthropic', 'openai', 'fal', 'github']) }, ['provider']),
  codexLogin: S(),
  codexLoginCancel: S(),
  codexLogout: S(),
  enginesStatus: S(),
  installEngine: S({ engine: str('Engine id to install.') }, ['engine']),
  cancelEngineInstall: S({ engine: str('Engine id whose install to cancel.') }, ['engine']),
  engineStatus: S(),
  githubStatus: S(),
  listGithubOwners: S(),
  githubLogin: S(),
  githubLoginCancel: S(),
  githubLogout: S(),
  ghCliState: S(),

  // ── memory ──────────────────────────────────────────────────────────────
  memorySyncStatus: S(),
  memorySyncNow: S({ projectId: str('Sync one project, or omit to sync all.') }),

  // ── browser ─────────────────────────────────────────────────────────────
  browserOpen: S({ projectId: str('Project id.'), startUrl: str('Initial URL.') }, ['projectId']),
  browserClose: S({ projectId: str('Project id.') }, ['projectId']),
  browserNavigate: S({ projectId: str('Project id.'), url: str('URL to navigate to.') }, ['projectId', 'url']),
  browserStatus: S({ projectId: str('Project id, or omit for all.') }),
  browserScreenshot: S({ projectId: str('Project id.'), fullPage: bool('Capture the full page.') }, ['projectId']),
  browserListComments: S({ projectId: str('Project id.') }, ['projectId']),
  browserClearData: S({ projectId: str('Project id.') }, ['projectId']),
  browserRevealProfile: S({ projectId: str('Project id.') }, ['projectId']),
  browserListChromeProfiles: S(),
  browserChromeStatus: S(),
  browserInstallChrome: S(),
  browserImportSeed: S({
    profileDir: str('Chrome profile directory to import.'), sourceName: str(), quitChrome: bool('Quit Chrome first.'),
  }, ['profileDir']),
  browserSeedInfo: S(),
  browserClearSeed: S(),

  // ── extension ───────────────────────────────────────────────────────────
  extensionStatus: S(),
  extensionSetActive: S({ clientId: str('Extension peer/client id to make active.') }, ['clientId']),
  extensionBrowserOpen: S({ url: str('URL to open (defaults to about:blank).') }),
  extensionBrowserClose: S(),
  extensionPath: S(),
  extensionRevealFolder: S(),

  // ── media ───────────────────────────────────────────────────────────────
  mediaRates: S(),
  listAssets: S({ projectId: str(), status: str('Filter by asset status.') }),
  getAsset: S({ id: str('Asset id.') }, ['id']),
  generateAsset: S({
    modelKey: str('Model key (e.g. an image/video model).'), prompt: str('Generation prompt.'),
    projectId: str(), durationS: num(), voice: str(), imageUrl: str(), aspect: str(),
  }, ['modelKey', 'prompt']),
  regenerateImage: S({
    assetId: str('Source image asset id (id also accepted).'), id: str('Alias of assetId.'),
    instruction: str('Edit instruction — omit to re-roll the original prompt.'),
    prompt: str('Override base prompt.'), jobId: str('Append the result to this chat turn.'),
  }, [], oneOf('assetId', 'id')),
  cancelAsset: S({ id: str('Asset id.') }, ['id']),
  deleteAsset: S({ id: str('Asset id.') }, ['id']),
  approveAsset: S({ id: str('Asset id.') }, ['id']),
  importAsset: S({ path: str('File to import as an asset.'), projectId: str('Owning project (optional).') }, ['path']),
  assetImage: S({ assetId: str('Asset id.') }, ['assetId']),

  // ── research ────────────────────────────────────────────────────────────
  runResearch: S({ topic: str('Research topic/query.') }, ['topic']),
  listBriefs: S(),
  listResearchRuns: S(),
  markBriefSent: S({ id: str('Brief id.') }, ['id']),

  // ── publishing ──────────────────────────────────────────────────────────
  listPublishDrafts: S(),
  listPublishLedger: S(),
  createDraft: S({ assetId: str('Asset to draft.'), caption: str(), platforms: strList() }, ['assetId']),
  updateDraft: S({
    id: str('Draft id.'), caption: str(), platforms: strList(),
    scheduledAt: numOrNull('Scheduled time (ms epoch) or null.'), status: enumStr(['draft', 'approved', 'scheduled']),
  }, ['id']),
  deleteDraft: S({ id: str('Draft id.') }, ['id']),
  scheduleDraft: S({ id: str('Draft id.'), scheduledAt: num('Scheduled time (ms epoch).') }, ['id', 'scheduledAt']),
  exportDraft: S({ id: str('Draft id.') }, ['id']),
  markPublished: S({ id: str('Draft id.') }, ['id']),

  // ── comms ───────────────────────────────────────────────────────────────
  commsStatus: S(),
  listChatBindings: S(),
  listPendingChats: S(),
  listCommEvents: S(),
  connectTelegram: S({ token: str('Telegram bot token.') }, ['token']),
  disconnectTelegram: S(),
  bindChat: S({
    chatId: str('Chat id to bind.'), name: str(), provider: enumStr(['telegram', 'whatsapp']),
    projectId: str('Project to bind to (optional).'), sessionId: str(), permissions: obj('{startJobs?, receiveReports?, approveGates?}.'),
  }, ['chatId']),
  unbindChat: S({ chatId: str('Chat id to unbind.') }, ['chatId']),
  setChatPermissions: S({ chatId: str('Chat id.'), permissions: obj('{startJobs?, receiveReports?, approveGates?}.') }, ['chatId', 'permissions']),

  // ── whatsapp ────────────────────────────────────────────────────────────
  whatsappStatus: S(),
  whatsappLink: S({ phone: str('Phone number for pairing-code linking (optional).') }),
  whatsappQr: S(),
  disconnectWhatsApp: S(),
  unlinkWhatsApp: S(),
  listWaChats: S(),
  waListChats: S(),
  waGetMessages: S({ chatId: str('WhatsApp chat id.'), limit: num(), before: num('Page before this ms timestamp.') }, ['chatId']),
  waChatInfo: S({ chatId: str('WhatsApp chat id.') }, ['chatId']),
  waSendText: S({ chatId: str('WhatsApp chat id.'), text: str('Message text.') }, ['chatId', 'text']),
  waSendMedia: S({
    chatId: str('WhatsApp chat id.'),
    kind: enumStr(['image', 'video', 'audio', 'document'], 'Media kind (default document).'),
    path: str('Local file path — nonblank (or use dataB64).'), dataB64: str('Base64 bytes — nonblank (or use path).'),
    mimetype: str(), fileName: str(), caption: str(),
  }, ['chatId'], oneOfNonblank('path', 'dataB64')),
  waReact: S({ chatId: str('WhatsApp chat id.'), msgId: str('Target message id.'), emoji: str('Reaction emoji.') }, ['chatId', 'msgId', 'emoji']),
  waMarkRead: S({ chatId: str('WhatsApp chat id.') }, ['chatId']),
  waSetTyping: S({ chatId: str('WhatsApp chat id.'), on: bool('Typing on/off.') }, ['chatId']),
  waFetchAvatar: S({ chatId: str('WhatsApp chat id.') }, ['chatId']),
  waDownloadMedia: S({ chatId: str('WhatsApp chat id.'), msgId: str('Media message id.') }, ['chatId', 'msgId']),
  approveWhatsappSend: S(),
  setWhatsappAgentSend: S({ on: bool('Allow the agent to send to non-own numbers.') }, ['on']),
  setWhatsappRecipient: S({ number: str('Personal recipient number ("" clears).') }, ['number']),
  listProjectWaChats: S({ projectId: str('Project id.') }, ['projectId']),
  addProjectWaChat: S({ projectId: str('Project id.'), chatId: str('WhatsApp chat id.') }, ['projectId', 'chatId']),
  removeProjectWaChat: S({ projectId: str('Project id.'), chatId: str('WhatsApp chat id.') }, ['projectId', 'chatId']),

  // ── feedback ────────────────────────────────────────────────────────────
  listFeedback: S(),
  submitFeedback: S({
    message: str('Feedback message.'), category: enumStr(['bug', 'idea', 'other']),
    source: enumStr(['desktop', 'web', 'phone']), context: obj('{screen?, platform?, projectId?}.'),
  }, ['message']),
  updateFeedback: S({ id: str('Feedback id.'), status: enumStr(['new', 'triaged', 'done'], 'The only accepted patch field — required.') }, ['id', 'status']),
  deleteFeedback: S({ id: str('Feedback id.') }, ['id']),
  feedbackCreateIssue: S({ id: str('Feedback id.'), repo: str('Target owner/repo (defaults to the settings feedbackRepo).') }, ['id']),

  // ── files ───────────────────────────────────────────────────────────────
  revealPath: S({ path: str('Path to reveal in Finder (a leading ~ expands).') }, ['path']),
  readFile: S({ projectId: str('Project id — REQUIRED (the dispatcher resolves roots from it; sessionId alone is not enough).'), path: str('File path (relative to a project root or absolute inside it).'), sessionId: str('Scope to a session worktree.') }, ['projectId', 'path']),
  listDir: S({ projectId: str('Project id — REQUIRED.'), path: str('Directory path (path-confined).'), sessionId: str('Scope to a session worktree.') }, ['projectId', 'path']),
  listProjectFiles: S({ projectId: str('Project id.') }, ['projectId']),
  writeFile: S({
    projectId: str('Project id — REQUIRED (the dispatcher resolves roots from it).'),
    path: str('File path (must be an existing text file inside a project root).'),
    text: str('New file contents (UTF-8, <= 4 MB, no NUL bytes).'),
    sessionId: str('Scope to a session worktree.'),
  }, ['projectId', 'path', 'text']),
  runCommand: S({ projectId: str('Project whose folder is the cwd.'), command: str('Shell command to run.') }, ['projectId', 'command']),
  killCommand: S({ runId: str('The runId returned by runCommand.') }, ['runId']),
};

/** The flat, ordered tool list — one entry per dispatch action. */
export const MCP_TOOLS: McpToolDef[] = (Object.keys(GROUPS) as McpCategoryId[]).flatMap((category) =>
  GROUPS[category].map(([method, description, destructive]): McpToolDef => ({
    method,
    category,
    description: destructive ? `${description} (DESTRUCTIVE)` : description,
    destructive: !!destructive,
    inputSchema: TOOL_SCHEMAS[method] ?? PASSTHROUGH_SCHEMA,
  })),
);

export const MCP_TOOL_BY_METHOD: ReadonlyMap<string, McpToolDef> = new Map(MCP_TOOLS.map((t) => [t.method, t]));

/** Shape one manifest entry into an MCP tools/list descriptor. */
export function toMcpTool(def: McpToolDef): { name: string; description: string; inputSchema: McpInputSchema } {
  return { name: def.method, description: def.description, inputSchema: def.inputSchema };
}

export interface McpCategoryCount extends McpCategoryDef {
  total: number;
  destructive: number;
}

/** Per-category tool counts (for the Settings UI). */
export function categoryCounts(): McpCategoryCount[] {
  return MCP_CATEGORIES.map((c) => {
    const tools = MCP_TOOLS.filter((t) => t.category === c.id);
    return { ...c, total: tools.length, destructive: tools.filter((t) => t.destructive).length };
  });
}
