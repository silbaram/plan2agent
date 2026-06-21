/* global React */
/*
  Mock data shared across all variations.
  This represents a developer's working state in the harness:
  - active project, AI sessions, sub-agents, skills in use.
*/

const MOCK = {
  user: { name: "정한민", handle: "@hanmin", avatar: "ㅎ" },

  projects: [
    { id: "checkout-v2", name: "checkout-v2",        path: "~/code/checkout-v2",        active: true,  unread: 0 },
    { id: "lumen-cli",   name: "lumen-cli",          path: "~/code/lumen-cli",          active: false, unread: 2 },
    { id: "atelier",     name: "atelier-portfolio",  path: "~/code/atelier",            active: false, unread: 0 },
    { id: "scratch",     name: "scratch",            path: "~/scratch",                 active: false, unread: 0 },
  ],

  agents: [
    {
      id: "claude-main",
      name: "claude code",
      provider: "claude",
      providerColor: "var(--p-claude)",
      state: "tool",        // dot character state
      task: "Editing src/lib/checkout/session.ts",
      model: "sonnet 4.5",
      tokens: { in: 24820, out: 3120 },
      duration: "00:04:12",
      pinned: true,
    },
    {
      id: "codex-tests",
      name: "codex",
      provider: "codex",
      providerColor: "var(--p-codex)",
      state: "thinking",
      task: "Generating test cases for paymentIntent",
      model: "gpt-5",
      tokens: { in: 8120, out: 1240 },
      duration: "00:01:48",
      pinned: false,
    },
    {
      id: "gemini-research",
      name: "gemini cli",
      provider: "gemini",
      providerColor: "var(--p-gemini)",
      state: "idle",
      task: "Idle — last: search Stripe webhooks",
      model: "2.5 pro",
      tokens: { in: 15400, out: 2800 },
      duration: "00:00:00",
      pinned: false,
    },
    {
      id: "claude-reviewer",
      name: "reviewer",
      provider: "claude",
      providerColor: "var(--p-claude)",
      state: "done",
      task: "Approved 3 files · 1 suggestion",
      model: "haiku 4.5",
      tokens: { in: 4220, out: 680 },
      duration: "00:00:32",
      pinned: false,
    },
    {
      id: "aider-bg",
      name: "aider",
      provider: "aider",
      providerColor: "var(--p-aider)",
      state: "sleep",
      task: "Paused — waiting for diff approval",
      model: "claude opus",
      tokens: { in: 0, out: 0 },
      duration: "—",
      pinned: false,
    },
  ],

  skills: [
    { id: "web-search",     name: "web search",       state: "active",  agent: "gemini cli" },
    { id: "diff-apply",     name: "diff apply",       state: "active",  agent: "claude code" },
    { id: "pdf-read",       name: "pdf read",         state: "idle",    agent: "—" },
    { id: "screenshot",     name: "screenshot",       state: "idle",    agent: "—" },
    { id: "test-runner",    name: "test runner",      state: "active",  agent: "codex" },
    { id: "git",            name: "git",              state: "idle",    agent: "—" },
  ],

  subagents: [
    { id: "sa-1", name: "test-generator", parent: "codex",       state: "active",  depth: 1 },
    { id: "sa-2", name: "type-checker",   parent: "claude code", state: "active",  depth: 1 },
    { id: "sa-3", name: "doc-writer",     parent: "claude code", state: "idle",    depth: 1 },
    { id: "sa-4", name: "git-helper",     parent: "claude code", state: "done",    depth: 1 },
  ],

  // Conversation transcript (slim — for the main panel)
  transcript: [
    { kind: "user",   ts: "16:42:08", body: "checkout 세션이 만료된 후에 재시도하면 가끔 401이 떨어져. 원인 찾고 src/lib/checkout/session.ts에서 고쳐줘." },
    { kind: "agent",  ts: "16:42:11", agent: "claude code", body: "session.ts와 그 의존성을 먼저 읽어볼게요." },
    { kind: "tool",   ts: "16:42:11", agent: "claude code", tool: "read_file", arg: "src/lib/checkout/session.ts" },
    { kind: "tool",   ts: "16:42:13", agent: "claude code", tool: "grep",      arg: "refreshToken" },
    { kind: "agent",  ts: "16:42:18", agent: "claude code", body: "원인을 찾았어요. `refreshToken()` 호출 시 세션 객체를 mutate 하지 않고 새 객체를 리턴하는데, 호출부에서 기존 세션 ref를 그대로 들고 있네요. patch를 만들었습니다." },
    { kind: "diff",   ts: "16:42:19", agent: "claude code", file: "src/lib/checkout/session.ts", added: 8, removed: 3 },
    { kind: "tool",   ts: "16:46:18", agent: "claude code", tool: "edit_file", arg: "src/lib/checkout/session.ts", running: true },
  ],

  files: [
    { name: "src",                    type: "dir", expanded: true,  depth: 0 },
    { name: "lib",                    type: "dir", expanded: true,  depth: 1 },
    { name: "checkout",               type: "dir", expanded: true,  depth: 2 },
    { name: "session.ts",             type: "file",                  depth: 3, modified: true,  agent: "claude" },
    { name: "intent.ts",              type: "file",                  depth: 3 },
    { name: "webhook.ts",             type: "file",                  depth: 3, modified: true,  agent: "claude" },
    { name: "auth",                   type: "dir", expanded: false, depth: 2 },
    { name: "components",             type: "dir", expanded: false, depth: 1 },
    { name: "tests",                  type: "dir", expanded: true,  depth: 0 },
    { name: "session.test.ts",        type: "file",                  depth: 1, modified: true,  agent: "codex" },
    { name: ".harness",               type: "dir", expanded: false, depth: 0 },
    { name: "package.json",           type: "file",                  depth: 0 },
    { name: "README.md",              type: "file",                  depth: 0 },
  ],

  // Recent sessions (left rail history)
  sessions: [
    { id: "s-1", title: "checkout 401 fix",          agent: "claude", ts: "now",      state: "tool",     unread: 0 },
    { id: "s-2", title: "test cases for paymentIntent", agent: "codex",  ts: "2m",     state: "thinking", unread: 0 },
    { id: "s-3", title: "stripe webhook research",   agent: "gemini", ts: "12m",     state: "idle",     unread: 1 },
    { id: "s-4", title: "review: feature/oauth",     agent: "claude", ts: "today",   state: "done",     unread: 0 },
    { id: "s-5", title: "rename DB columns",         agent: "aider",  ts: "today",   state: "sleep",    unread: 0 },
    { id: "s-6", title: "audit dependencies",        agent: "codex",  ts: "yesterday", state: "done",   unread: 0 },
    { id: "s-7", title: "refactor: pricing module",  agent: "claude", ts: "2d",      state: "done",     unread: 0 },
    { id: "s-8", title: "wireframe → JSX prototype", agent: "gemini", ts: "3d",      state: "done",     unread: 0 },
  ],
};

window.MOCK = MOCK;
