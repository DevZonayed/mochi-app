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
// Descriptions are intentionally terse — the params for most methods are a small object;
// where the shape matters we hint the key params inline. The input schema is a permissive
// object (additionalProperties) so an external agent can pass exactly what dispatch expects
// without us duplicating 185 bespoke Zod schemas that would drift from localApi.ts.

export type McpCategoryId =
  | 'system' | 'projects' | 'design' | 'sessions' | 'git' | 'jobs'
  | 'schedule' | 'skills' | 'mcp' | 'providers' | 'memory'
  | 'browser' | 'extension' | 'media' | 'research' | 'publishing'
  | 'comms' | 'whatsapp' | 'feedback' | 'files';

export interface McpToolDef {
  /** The dispatch method name — also the MCP tool name exposed to the outside agent. */
  method: string;
  category: McpCategoryId;
  description: string;
  /** Irreversible / outward-facing / shell-filesystem-auth mutating — gated behind allowDestructive. */
  destructive?: boolean;
  /** Optional hint of the important params (shown in the description tail). */
  params?: string;
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

// Compact table: [method, description, destructive?]. Grouped by category.
type Row = [method: string, description: string, destructive?: boolean];
const GROUPS: Record<McpCategoryId, Row[]> = {
  system: [
    ['health', 'Liveness check of the brain.'],
    ['dashboard', 'The home dashboard payload (greeting projects, gates, active/recent jobs, schedule, budget).'],
    ['budget', 'Budget cap + spend, broken down by project.'],
    ['costs', 'Cost analytics (today / month / by day / project / engine).'],
    ['claudeUsage', 'Claude subscription usage (five-hour + seven-day utilization). Pass {force:true} to re-fetch.'],
    ['listEvents', 'The app event log.'],
    ['setBudgetCap', 'Set the monthly budget cap. Params: {cap:number}.'],
    ['getSettings', 'Read all app settings.'],
    ['setSettings', 'Patch app settings. Params: a partial settings object.'],
    ['listWorkspaces', 'List workspaces.'],
    ['createWorkspace', 'Create a workspace. Params: {name}.'],
    ['getRoles', 'Read primary/reviewer engine roles.'],
    ['setRoles', 'Set primary/reviewer engine roles.'],
    ['getRouting', 'Read per-purpose model routing.'],
    ['setRouting', 'Set per-purpose model routing.'],
    ['getPairing', 'Get the relay pairing code for phone/web remotes.'],
    ['listModels', 'List available models grouped by engine.'],
    ['listOwners', 'List GitHub owners (personal + orgs) available for repos.'],
    ['checkSlug', 'Validate/normalize a project slug. Params: {name}.'],
  ],
  projects: [
    ['listProjects', 'List all projects.'],
    ['getProject', 'Get one project. Params: {projectId}.'],
    ['getProjectMemory', 'Read a project\'s agent memory (.continuum). Params: {projectId}.'],
    ['setProjectMemory', 'Write a project\'s agent memory. Params: {projectId, content}.'],
    ['snapshotProject', 'Take a project snapshot. Params: {projectId}.'],
    ['createProject', 'Create a project. Params: {name, kind?, path?, …}.'],
    ['openProject', 'Open/activate a project. Params: {projectId}.'],
    ['closeProject', 'Close a project. Params: {projectId}.'],
    ['updateProject', 'Update project fields. Params: {projectId, …}.'],
    ['reorderProjects', 'Reorder projects. Params: {order:string[]}.'],
    ['getProjectRepo', 'Get a project\'s git repo info. Params: {projectId}.'],
    ['githubRepoMetadata', 'Fetch GitHub repo metadata. Params: {repo}.'],
    ['cloneRepo', 'Clone a GitHub repo into a new project. Params: {repo, …}.', true],
    ['revealProject', 'Reveal a project folder in Finder. Params: {projectId}.'],
    ['deleteProject', 'Delete a project. Params: {projectId}.', true],
    ['bootstrapProject', 'Bootstrap/scaffold a project. Params: {projectId, …}.'],
    ['adoptFolderInspect', 'Inspect a folder before adopting it as a project. Params: {path}.'],
    ['browseDir', 'Browse a directory (file picker backend). Params: {path}.'],
    ['inspectFolder', 'Inspect a folder\'s contents. Params: {path}.'],
    ['gitAvailable', 'Whether git is available on this machine.'],
  ],
  design: [
    ['listDesignComments', 'List design comments. Params: {projectId}.'],
    ['addDesignComment', 'Add a design comment. Params: {projectId, …}.'],
    ['setDesignCommentStatus', 'Set a design comment status. Params: {id, status}.'],
    ['deleteDesignComment', 'Delete a design comment. Params: {id}.', true],
    ['copyDesignToCode', 'Copy a design artifact into code. Params: {projectId, …}.'],
  ],
  sessions: [
    ['listSessions', 'List chat sessions in a project. Params: {projectId}.'],
    ['listBranches', 'List branches for a project. Params: {projectId}.'],
    ['createSession', 'Create a chat session. Params: {projectId, …}.'],
    ['renameSession', 'Rename a session. Params: {sessionId, title}.'],
    ['deleteSession', 'Delete a session. Params: {sessionId}.', true],
    ['pinSession', 'Pin/unpin a session. Params: {sessionId, pinned}.'],
    ['archiveSession', 'Archive/unarchive a session. Params: {sessionId, archived}.'],
    ['continueSession', 'Resume a session. Params: {sessionId}.'],
    ['setSessionAutopilot', 'Toggle autopilot for a session. Params: {sessionId, on}.'],
    ['setSessionReviewer', 'Set the reviewer model for a session. Params: {sessionId, reviewer}.'],
    ['sendChat', 'Send a chat turn to the agent (the main entrypoint). Params: {projectId, sessionId?, prompt, …}.'],
    ['scanConversations', 'Scan external CLI conversation history to import. Params: {projectId}.'],
    ['importConversations', 'Import scanned conversations. Params: {projectId, …}.'],
  ],
  git: [
    ['getSessionGitStatus', 'Read a session\'s git/PR status. Params: {sessionId}.'],
    ['refreshSessionGitStatus', 'Force-refresh a session\'s git status. Params: {sessionId}.'],
    ['pushSession', 'Push a session\'s branch to origin. Params: {sessionId}.', true],
    ['createSessionPR', 'Open a PR from a session\'s branch. Params: {sessionId, title?, body?}.', true],
    ['mergeSessionPR', 'Merge a session\'s PR (human-confirmed in UI). Params: {sessionId, …}.', true],
    ['resolveSession', 'Resolve a session\'s merge conflicts (human-confirmed). Params: {sessionId}.', true],
    ['previewSessionMerge', 'Preview a session merge. Params: {sessionId}.'],
    ['previewSessionResolve', 'Preview a conflict resolution. Params: {sessionId}.'],
    ['getConflictHunks', 'Get conflict hunks for a session. Params: {sessionId}.'],
    ['setConflictResolveHint', 'Set a conflict-resolution hint. Params: {sessionId, …}.'],
    ['renameSessionBranch', 'Rename a session\'s branch. Params: {sessionId, …}.'],
    ['archiveSessionWorktree', 'Archive a session\'s git worktree. Params: {sessionId}.', true],
  ],
  jobs: [
    ['listJobs', 'List jobs.'],
    ['listJobPage', 'List a page of jobs. Params: {cursor?, limit?}.'],
    ['getJob', 'Get one job. Params: {jobId}.'],
    ['getJobDiff', 'Get a job\'s diff. Params: {jobId}.'],
    ['createJob', 'Create a job (not run). Params: {projectId, input, …}.'],
    ['runJob', 'Run an existing job. Params: {jobId}.'],
    ['cancelJob', 'Cancel a running job. Params: {jobId}.'],
    ['steerJob', 'Inject a steering message into a running job. Params: {jobId, text}.'],
    ['deleteJob', 'Delete a job. Params: {jobId}.', true],
    ['createAndRunJob', 'Create and immediately run a job. Params: {projectId, input, …}.'],
    ['listBgTasks', 'List background tasks. Params: {projectId?}.'],
    ['bgOutput', 'Read a background task\'s output. Params: {id, tailKB?}.'],
    ['stopBgTask', 'Stop a background task. Params: {id}.', true],
    ['listApprovals', 'List pending tool-use approvals.'],
    ['approveApproval', 'Approve a pending tool-use gate. Params: {id}.'],
    ['denyApproval', 'Deny a pending tool-use gate. Params: {id}.'],
    ['answerQuestion', 'Answer an agent AskUserQuestion. Params: {id, answer}.'],
    ['extendQuestion', 'Extend an agent question\'s deadline. Params: {id, …}.'],
  ],
  schedule: [
    ['listSchedules', 'List schedules. Params: {projectId?}.'],
    ['createSchedule', 'Create a schedule. Params: {projectId, sessionId?, prompt, fireAt|cron, …}.'],
    ['toggleSchedule', 'Enable/disable a schedule. Params: {id, enabled}.'],
    ['updateSchedule', 'Edit a schedule. Params: {id, …}.'],
    ['deleteSchedule', 'Delete a schedule. Params: {id}.', true],
    ['scheduleCheck', 'Manually run the schedule due-check tick.'],
    ['scheduleMessage', 'Schedule a one-shot message. Params: {sessionId, prompt, fireAt}.'],
  ],
  skills: [
    ['listSkills', 'List registry/known skills.'],
    ['toggleSkill', 'Enable/disable a skill. Params: {id, enabled}.'],
    ['listTemplates', 'List project templates.'],
    ['searchSkills', 'Search the skill registry. Params: {query, limit?}.'],
    ['skillRegistryMeta', 'Get registry metadata.'],
    ['registryGetSkill', 'Get one registry skill. Params: {skillId}.'],
    ['registrySkillContent', 'Get a registry skill\'s SKILL.md content. Params: {skillId}.'],
    ['listProjectSkills', 'List skills installed in a project. Params: {projectId}.'],
    ['addSkillToProject', 'Install a skill into a project. Params: {projectId, skillId}.'],
    ['setProjectSkillEnabled', 'Enable/disable an installed project skill. Params: {projectId, skillId, enabled}.'],
    ['removeSkillFromProject', 'Remove an installed project skill. Params: {projectId, skillId}.', true],
  ],
  mcp: [
    ['listMcpServers', 'List operator-configured (outbound) MCP servers.'],
    ['addMcpServer', 'Add an outbound MCP server. Params: {name, …}.'],
    ['updateMcpServer', 'Update an outbound MCP server. Params: {id, …}.'],
    ['setMcpServerEnabled', 'Enable/disable an outbound MCP server. Params: {id, enabled}.'],
    ['removeMcpServer', 'Remove an outbound MCP server. Params: {id}.', true],
  ],
  providers: [
    ['listProviders', 'List connected providers / API keys.'],
    ['connectProvider', 'Connect a provider / store an API key. Params: {provider, key}.', true],
    ['disconnectProvider', 'Disconnect a provider. Params: {provider}.', true],
    ['codexLogin', 'Start Codex (ChatGPT) login.'],
    ['codexLoginCancel', 'Cancel a Codex login.'],
    ['codexLogout', 'Sign out of Codex.', true],
    ['enginesStatus', 'Status of all engine binaries.'],
    ['installEngine', 'Download/install an engine binary. Params: {engine}.', true],
    ['cancelEngineInstall', 'Cancel an engine install. Params: {engine}.'],
    ['engineStatus', 'Status of one engine. Params: {engine}.'],
    ['githubStatus', 'GitHub auth status.'],
    ['listGithubOwners', 'List GitHub owners (personal + orgs).'],
    ['githubLogin', 'Start GitHub device-flow login.'],
    ['githubLoginCancel', 'Cancel a GitHub login.'],
    ['githubLogout', 'Sign out of GitHub.', true],
    ['ghCliState', 'State of the bundled gh CLI.'],
  ],
  memory: [
    ['memorySyncStatus', 'Memory-repository sync status.'],
    ['memorySyncNow', 'Force a memory-repository sync now.'],
  ],
  browser: [
    ['browserOpen', 'Open the per-project browser. Params: {projectId}.'],
    ['browserClose', 'Close the per-project browser. Params: {projectId}.'],
    ['browserNavigate', 'Navigate the browser. Params: {projectId, url}.'],
    ['browserStatus', 'Browser status. Params: {projectId}.'],
    ['browserScreenshot', 'Screenshot the browser. Params: {projectId, …}.'],
    ['browserListComments', 'List browser design comments. Params: {projectId}.'],
    ['browserClearData', 'Clear the browser profile data. Params: {projectId}.', true],
    ['browserRevealProfile', 'Reveal the browser profile folder. Params: {projectId}.'],
    ['browserListChromeProfiles', 'List installed Chrome profiles.'],
    ['browserChromeStatus', 'Whether Chrome is installed/detected.'],
    ['browserInstallChrome', 'Install Chrome for automation.', true],
    ['browserImportSeed', 'Import a Chrome profile seed (cookies/storage). Params: {…}.'],
    ['browserSeedInfo', 'Inspect a Chrome profile seed. Params: {…}.'],
    ['browserClearSeed', 'Clear an imported browser seed. Params: {projectId}.', true],
  ],
  extension: [
    ['extensionStatus', 'Native browser-extension bridge status.'],
    ['extensionSetActive', 'Set the active extension peer. Params: {peerId}.'],
    ['extensionBrowserOpen', 'Open the user\'s real Chrome via the extension. Params: {…}.'],
    ['extensionBrowserClose', 'Close the extension-driven browser.'],
    ['extensionPath', 'Path to the bundled extension.'],
    ['extensionRevealFolder', 'Reveal the extension folder in Finder.'],
  ],
  media: [
    ['mediaRates', 'Media generation model rates.'],
    ['listAssets', 'List media assets. Params: {projectId?}.'],
    ['getAsset', 'Get one asset. Params: {assetId}.'],
    ['generateAsset', 'Generate a media asset (image/audio/video/music). Params: {modelKey, prompt, projectId?, …}.'],
    ['regenerateImage', 'Regenerate/edit an image asset. Params: {assetId, …}.'],
    ['cancelAsset', 'Cancel a generating asset. Params: {assetId}.'],
    ['deleteAsset', 'Delete an asset. Params: {assetId}.', true],
    ['approveAsset', 'Approve an asset. Params: {assetId}.'],
    ['importAsset', 'Import a file as an asset. Params: {projectId, path}.'],
    ['assetImage', 'Read an asset image (bytes/data-url). Params: {assetId}.'],
  ],
  research: [
    ['runResearch', 'Run a research task. Params: {projectId?, query, …}.'],
    ['listBriefs', 'List research briefs.'],
    ['listResearchRuns', 'List research runs.'],
    ['markBriefSent', 'Mark a research brief as sent. Params: {id}.'],
  ],
  publishing: [
    ['listPublishDrafts', 'List publish drafts.'],
    ['listPublishLedger', 'List the publish ledger.'],
    ['createDraft', 'Create a publish draft. Params: {…}.'],
    ['updateDraft', 'Update a publish draft. Params: {id, …}.'],
    ['deleteDraft', 'Delete a publish draft. Params: {id}.', true],
    ['scheduleDraft', 'Schedule a publish draft. Params: {id, fireAt}.', true],
    ['exportDraft', 'Export a publish draft. Params: {id, …}.', true],
    ['markPublished', 'Mark a draft as published. Params: {id}.', true],
  ],
  comms: [
    ['commsStatus', 'Telegram/comms status.'],
    ['listChatBindings', 'List project↔chat bindings.'],
    ['listPendingChats', 'List unbound inbound chats.'],
    ['listCommEvents', 'List comms events.'],
    ['connectTelegram', 'Connect a Telegram bot. Params: {token}.', true],
    ['disconnectTelegram', 'Disconnect Telegram.', true],
    ['bindChat', 'Bind a chat to a project. Params: {projectId, chatId, …}.'],
    ['unbindChat', 'Unbind a chat. Params: {chatId}.'],
    ['setChatPermissions', 'Set a bound chat\'s permissions. Params: {chatId, …}.'],
  ],
  whatsapp: [
    ['whatsappStatus', 'WhatsApp connection status.'],
    ['whatsappLink', 'Begin linking WhatsApp (returns pairing state).'],
    ['whatsappQr', 'Get the current WhatsApp link QR.'],
    ['disconnectWhatsApp', 'Disconnect the WhatsApp socket.', true],
    ['unlinkWhatsApp', 'Unlink WhatsApp entirely.', true],
    ['listWaChats', 'List WhatsApp chats.'],
    ['waListChats', 'List WhatsApp chats (alias).'],
    ['waGetMessages', 'Read messages from a WhatsApp chat. Params: {chatId, …}.'],
    ['waChatInfo', 'Info about a WhatsApp chat. Params: {chatId}.'],
    ['waSendText', 'Send a WhatsApp text message. Params: {chatId?|phone?, text}.', true],
    ['waSendMedia', 'Send WhatsApp media. Params: {chatId, path|url, …}.', true],
    ['waReact', 'React to a WhatsApp message. Params: {chatId, messageId, emoji}.', true],
    ['waMarkRead', 'Mark a WhatsApp chat as read. Params: {chatId}.'],
    ['waSetTyping', 'Set typing state in a WhatsApp chat. Params: {chatId, on}.', true],
    ['waFetchAvatar', 'Fetch a WhatsApp contact avatar. Params: {chatId}.'],
    ['waDownloadMedia', 'Download a WhatsApp media message. Params: {chatId, messageId}.'],
    ['approveWhatsappSend', 'Approve a gated WhatsApp send. Params: {id}.'],
    ['setWhatsappAgentSend', 'Toggle whether the agent may send to non-own numbers. Params: {enabled}.', true],
    ['setWhatsappRecipient', 'Set the personal WhatsApp recipient number. Params: {phone}.'],
    ['listProjectWaChats', 'List WhatsApp chats bound to a project. Params: {projectId}.'],
    ['addProjectWaChat', 'Bind a WhatsApp chat to a project. Params: {projectId, chatId}.'],
    ['removeProjectWaChat', 'Unbind a WhatsApp chat from a project. Params: {projectId, chatId}.', true],
  ],
  feedback: [
    ['listFeedback', 'List in-app feedback.'],
    ['submitFeedback', 'Submit feedback. Params: {text, …}.'],
    ['updateFeedback', 'Update a feedback item. Params: {id, …}.'],
    ['deleteFeedback', 'Delete a feedback item. Params: {id}.', true],
    ['feedbackCreateIssue', 'Escalate feedback to a GitHub issue. Params: {id}.', true],
  ],
  files: [
    ['revealPath', 'Reveal a path in Finder. Params: {path}.'],
    ['readFile', 'Read a file (path-confined to project roots). Params: {sessionId?, path}.'],
    ['listDir', 'List a directory (path-confined). Params: {sessionId?, path}.'],
    ['listProjectFiles', 'List a project\'s files. Params: {projectId}.'],
    ['writeFile', 'Overwrite a file (path-confined). Params: {sessionId?, path, content}.', true],
    ['runCommand', 'Run a shell command (path-confined). Params: {projectId|cwd, command}.', true],
    ['killCommand', 'Kill a running command. Params: {id}.', true],
  ],
};

const PASSTHROUGH_SCHEMA = { type: 'object' as const, additionalProperties: true, properties: {} };

/** The flat, ordered tool list — one entry per dispatch action. */
export const MCP_TOOLS: McpToolDef[] = (Object.keys(GROUPS) as McpCategoryId[]).flatMap((category) =>
  GROUPS[category].map(([method, description, destructive]): McpToolDef => ({
    method,
    category,
    description: destructive ? `${description} (DESTRUCTIVE)` : description,
    destructive: !!destructive,
  })),
);

export const MCP_TOOL_BY_METHOD: ReadonlyMap<string, McpToolDef> = new Map(MCP_TOOLS.map((t) => [t.method, t]));

/** Shape one manifest entry into an MCP tools/list descriptor. */
export function toMcpTool(def: McpToolDef): { name: string; description: string; inputSchema: typeof PASSTHROUGH_SCHEMA } {
  return { name: def.method, description: def.description, inputSchema: PASSTHROUGH_SCHEMA };
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
