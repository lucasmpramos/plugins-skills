import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

interface ClickUpConfig {
  apiKey: string;
  teamId: string;
  defaultLimit?: number;
}

const BASE_URL = "https://api.clickup.com/api/v2";

const PRIORITY_LABELS: Record<number, string> = { 1: "Urgent", 2: "High", 3: "Normal", 4: "Low" };

function formatDate(ts?: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatTask(t: Record<string, unknown>): string {
  const id = (t.custom_id as string) || (t.id as string) || "?";
  const name = (t.name as string) || "Untitled";
  const status = ((t.status as Record<string, unknown>)?.status as string) || "—";
  const due = formatDate((t.due_date as string) ? Number(t.due_date) : null);
  const assignees = ((t.assignees as Array<Record<string, unknown>>) || [])
    .map((a) => a.username || a.email || "?")
    .join(", ");
  const priority = t.priority
    ? PRIORITY_LABELS[Number((t.priority as Record<string, unknown>)?.id)] || "—"
    : "—";
  const parts = [`[${id}] ${name}`, status, `Due ${due}`, priority];
  if (assignees) parts.push(assignees);
  return `• ${parts.join(" · ")}`;
}

async function clickupFetch(
  path: string,
  apiKey: string,
  options: RequestInit = {},
): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok || data.err) {
    throw new Error(`${options.method ?? "GET"} ${path} → ${(data.err as string) || `HTTP ${res.status}`}`);
  }
  return data;
}

type ActionHandler = (args: Record<string, unknown>, config: ClickUpConfig) => Promise<string>;

const ACTIONS: Record<string, { desc: string; required?: string[]; handler: ActionHandler }> = {
  getWorkspace: {
    desc: "List all spaces in the workspace",
    handler: async (_args, config) => {
      const data = (await clickupFetch(`/team`, config.apiKey)) as Record<string, unknown>;
      const teams = (data.teams as Array<Record<string, unknown>>) || [];
      const team = teams.find((t) => String(t.id) === config.teamId) || teams[0];
      if (!team) return "No workspace found.";
      const spaces = (team.spaces as Array<Record<string, unknown>>) || [];
      const lines = spaces.map((s) => `• ${s.name} (${s.id})`);
      return `🏢 Workspace: ${team.name}\n\n${lines.join("\n") || "No spaces."}`;
    },
  },

  getSpaces: {
    desc: "List spaces in the workspace",
    handler: async (_args, config) => {
      const data = (await clickupFetch(
        `/team/${config.teamId}/space?archived=false`,
        config.apiKey,
      )) as Record<string, unknown>;
      const spaces = (data.spaces as Array<Record<string, unknown>>) || [];
      if (!spaces.length) return "No spaces found.";
      return `📁 Spaces (${spaces.length})\n${spaces.map((s) => `• ${s.name} — ID: ${s.id}`).join("\n")}`;
    },
  },

  getFolders: {
    desc: "List folders in a space. Args: spaceId",
    required: ["spaceId"],
    handler: async (args, config) => {
      const data = (await clickupFetch(
        `/space/${args.spaceId}/folder?archived=false`,
        config.apiKey,
      )) as Record<string, unknown>;
      const folders = (data.folders as Array<Record<string, unknown>>) || [];
      if (!folders.length) return "No folders in this space.";
      return `📂 Folders (${folders.length})\n${folders.map((f) => `• ${f.name} — ID: ${f.id}`).join("\n")}`;
    },
  },

  getLists: {
    desc: "List task lists in a folder. Args: folderId",
    required: ["folderId"],
    handler: async (args, config) => {
      const data = (await clickupFetch(
        `/folder/${args.folderId}/list?archived=false`,
        config.apiKey,
      )) as Record<string, unknown>;
      const lists = (data.lists as Array<Record<string, unknown>>) || [];
      if (!lists.length) return "No lists in this folder.";
      return `📋 Lists (${lists.length})\n${lists.map((l) => `• ${l.name} — ID: ${l.id} (${(l.task_count as number) || 0} tasks)`).join("\n")}`;
    },
  },

  getSpaceLists: {
    desc: "List folderless lists in a space. Args: spaceId",
    required: ["spaceId"],
    handler: async (args, config) => {
      const data = (await clickupFetch(
        `/space/${args.spaceId}/list?archived=false`,
        config.apiKey,
      )) as Record<string, unknown>;
      const lists = (data.lists as Array<Record<string, unknown>>) || [];
      if (!lists.length) return "No folderless lists in this space.";
      return `📋 Lists (${lists.length})\n${lists.map((l) => `• ${l.name} — ID: ${l.id} (${(l.task_count as number) || 0} tasks)`).join("\n")}`;
    },
  },

  getTasks: {
    desc: "Get tasks from a list. Args: listId, limit(optional), page(optional), statuses(optional array), assignees(optional array of user IDs)",
    required: ["listId"],
    handler: async (args, config) => {
      const limit = Number(args.limit ?? config.defaultLimit ?? 20);
      const page = Number(args.page ?? 0);
      let url = `/list/${args.listId}/task?archived=false&page=${page}&limit=${limit}&include_closed=true`;
      if (Array.isArray(args.statuses)) {
        for (const s of args.statuses) url += `&statuses[]=${encodeURIComponent(String(s))}`;
      }
      if (Array.isArray(args.assignees)) {
        for (const a of args.assignees) url += `&assignees[]=${a}`;
      }
      const data = (await clickupFetch(url, config.apiKey)) as Record<string, unknown>;
      const tasks = (data.tasks as Array<Record<string, unknown>>) || [];
      if (!tasks.length) return "No tasks found.";
      const lines = tasks.map(formatTask);
      return `📋 ${tasks.length} task(s)\n${lines.join("\n")}`;
    },
  },

  searchTasks: {
    desc: "Search tasks across the workspace. Args: query, limit(optional), statuses(optional array), list_ids(optional array)",
    required: ["query"],
    handler: async (args, config) => {
      const limit = Number(args.limit ?? config.defaultLimit ?? 20);
      let url = `/team/${config.teamId}/task?page=0&limit=${limit}&include_closed=true&query=${encodeURIComponent(String(args.query))}`;
      if (Array.isArray(args.statuses)) {
        for (const s of args.statuses) url += `&statuses[]=${encodeURIComponent(String(s))}`;
      }
      if (Array.isArray(args.list_ids)) {
        for (const id of args.list_ids) url += `&list_ids[]=${id}`;
      }
      const data = (await clickupFetch(url, config.apiKey)) as Record<string, unknown>;
      const tasks = (data.tasks as Array<Record<string, unknown>>) || [];
      if (!tasks.length) return `No tasks found for "${args.query}".`;
      return `🔍 ${tasks.length} result(s) for "${args.query}"\n${tasks.map(formatTask).join("\n")}`;
    },
  },

  getTask: {
    desc: "Get full details of a task. Args: taskId, includeComments(optional bool, default false)",
    required: ["taskId"],
    handler: async (args, config) => {
      const data = (await clickupFetch(`/task/${args.taskId}`, config.apiKey)) as Record<
        string,
        unknown
      >;
      const t = data as Record<string, unknown>;
      const id = (t.custom_id as string) || (t.id as string);
      const status = ((t.status as Record<string, unknown>)?.status as string) || "—";
      const priority = t.priority
        ? PRIORITY_LABELS[Number((t.priority as Record<string, unknown>)?.id)] || "—"
        : "—";
      const assignees =
        ((t.assignees as Array<Record<string, unknown>>) || [])
          .map((a) => a.username || a.email)
          .join(", ") || "Unassigned";
      const due = formatDate((t.due_date as string) ? Number(t.due_date) : null);
      const desc = (t.description as string)?.slice(0, 300) || "—";

      let out = `📌 ${t.name}\n`;
      out += `ID: ${id} | Status: ${status} | Priority: ${priority} | Due: ${due}\n`;
      out += `Assignees: ${assignees}\n`;
      if (t.url) out += `URL: ${t.url}\n`;
      out += `\nDescription:\n${desc}`;
      if ((t.description as string)?.length > 300) out += "…";

      if (args.includeComments) {
        try {
          const cdata = (await clickupFetch(
            `/task/${args.taskId}/comment`,
            config.apiKey,
          )) as Record<string, unknown>;
          const comments = (cdata.comments as Array<Record<string, unknown>>) || [];
          if (comments.length) {
            out += `\n\nComments (${comments.length}):\n`;
            for (const c of comments.slice(0, 10)) {
              const user = ((c.user as Record<string, unknown>)?.username as string) || "?";
              const text =
                ((c.comment as Array<Record<string, unknown>>)?.[0]?.text as string) || "";
              out += `  [${user}] ${text.slice(0, 150)}\n`;
            }
          }
        } catch {
          // ignore comment fetch errors
        }
      }

      return out;
    },
  },

  createTask: {
    desc: "Create a task in a list. Args: listId, name, description(optional), status(optional), priority(optional 1-4), due_date(optional timestamp ms), assignees(optional array of user IDs)",
    required: ["listId", "name"],
    handler: async (args, config) => {
      const body: Record<string, unknown> = { name: args.name };
      if (args.description) body.description = args.description;
      if (args.status) body.status = args.status;
      if (args.priority) body.priority = Number(args.priority);
      if (args.due_date) body.due_date = String(args.due_date);
      if (Array.isArray(args.assignees)) body.assignees = args.assignees;

      const data = (await clickupFetch(`/list/${args.listId}/task`, config.apiKey, {
        method: "POST",
        body: JSON.stringify(body),
      })) as Record<string, unknown>;

      const id = (data.custom_id as string) || (data.id as string);
      return `✅ Task created: [${id}] ${data.name}\n${data.url || ""}`;
    },
  },

  updateTask: {
    desc: "Update a task. Args: taskId, name(optional), description(optional), status(optional), priority(optional 1-4), due_date(optional timestamp ms), assignees(optional array)",
    required: ["taskId"],
    handler: async (args, config) => {
      const { taskId, ...fields } = args;
      const body: Record<string, unknown> = {};
      if (fields.name) body.name = fields.name;
      if (fields.description) body.description = fields.description;
      if (fields.status) body.status = fields.status;
      if (fields.priority) body.priority = Number(fields.priority);
      if (fields.due_date) body.due_date = String(fields.due_date);
      if (Array.isArray(fields.assignees)) body.assignees = fields.assignees;

      const data = (await clickupFetch(`/task/${taskId}`, config.apiKey, {
        method: "PUT",
        body: JSON.stringify(body),
      })) as Record<string, unknown>;

      const id = (data.custom_id as string) || (data.id as string);
      return `✅ Task updated: [${id}] ${data.name}`;
    },
  },

  addComment: {
    desc: "Add a comment to a task. Args: taskId, comment_text",
    required: ["taskId", "comment_text"],
    handler: async (args, config) => {
      await clickupFetch(`/task/${args.taskId}/comment`, config.apiKey, {
        method: "POST",
        body: JSON.stringify({ comment_text: args.comment_text }),
      });
      return `💬 Comment added to task ${args.taskId}`;
    },
  },

  getComments: {
    desc: "Get comments on a task. Args: taskId",
    required: ["taskId"],
    handler: async (args, config) => {
      const data = (await clickupFetch(`/task/${args.taskId}/comment`, config.apiKey)) as Record<
        string,
        unknown
      >;
      const comments = (data.comments as Array<Record<string, unknown>>) || [];
      if (!comments.length) return "No comments on this task.";
      const lines = comments.map((c) => {
        const user = ((c.user as Record<string, unknown>)?.username as string) || "?";
        const text = ((c.comment as Array<Record<string, unknown>>)?.[0]?.text as string) || "";
        const date = formatDate(c.date ? Number(c.date) : null);
        return `[${user} · ${date}] ${text.slice(0, 200)}`;
      });
      return `💬 ${comments.length} comment(s)\n${lines.join("\n")}`;
    },
  },

  getMembers: {
    desc: "Get members of a list. Args: listId",
    required: ["listId"],
    handler: async (args, config) => {
      const data = (await clickupFetch(`/list/${args.listId}/member`, config.apiKey)) as Record<
        string,
        unknown
      >;
      const members = (data.members as Array<Record<string, unknown>>) || [];
      if (!members.length) return "No members found.";
      return `👥 Members (${members.length})\n${members.map((m) => `• ${m.username} (${m.email}) — ID: ${m.id}`).join("\n")}`;
    },
  },

  getTimeEntries: {
    desc: "Get time entries. Args: start_date(optional timestamp ms), end_date(optional timestamp ms), assignee(optional user ID)",
    handler: async (args, config) => {
      let url = `/team/${config.teamId}/time_entries?`;
      if (args.start_date) url += `start_date=${args.start_date}&`;
      if (args.end_date) url += `end_date=${args.end_date}&`;
      if (args.assignee) url += `assignee=${args.assignee}&`;
      const data = (await clickupFetch(url, config.apiKey)) as Record<string, unknown>;
      const entries = (data.data as Array<Record<string, unknown>>) || [];
      if (!entries.length) return "No time entries found.";
      const lines = entries.slice(0, 20).map((e) => {
        const task = (e.task as Record<string, unknown>)?.name || "—";
        const user = (e.user as Record<string, unknown>)?.username || "?";
        const mins = Math.round(Number(e.duration) / 60000);
        return `• ${user} · ${task} · ${mins} min`;
      });
      return `⏱️ ${entries.length} time entry(ies)\n${lines.join("\n")}`;
    },
  },

  createTimeEntry: {
    desc: "Log a time entry. Args: task_id, duration(ms), start(timestamp ms), description(optional)",
    required: ["task_id", "duration", "start"],
    handler: async (args, config) => {
      const body: Record<string, unknown> = {
        tid: args.task_id,
        duration: Number(args.duration),
        start: Number(args.start),
      };
      if (args.description) body.description = args.description;
      const data = (await clickupFetch(`/team/${config.teamId}/time_entry`, config.apiKey, {
        method: "POST",
        body: JSON.stringify(body),
      })) as Record<string, unknown>;
      const entry = (data.data as Record<string, unknown>) || {};
      const mins = Math.round(Number(entry.duration) / 60000);
      return `⏱️ Time entry logged: ${mins} min on task ${args.task_id}`;
    },
  },
};

export function createClickUpApiTool(api: OpenClawPluginApi) {
  const config = (api.pluginConfig ?? {}) as unknown as ClickUpConfig;

  if (!config.apiKey || !config.teamId) {
    api.logger?.warn?.("clickup-api: missing config (apiKey or teamId). Tool disabled.");
    return null;
  }

  const actionDescriptions = Object.entries(ACTIONS)
    .map(([name, def]) => `- ${name}: ${def.desc}`)
    .join("\n");

  return {
    name: "clickup_api",
    description: `Interact with ClickUp workspace — tasks, lists, docs, time tracking.

## Available Actions
${actionDescriptions}`,
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: Object.keys(ACTIONS),
          description: "The action to perform",
        },
        args: {
          type: "object" as const,
          description: "Action-specific arguments",
          additionalProperties: true,
        },
      },
      required: ["action"] as const,
    },
    async execute(_toolUseId: string, params: { action: string; args?: Record<string, unknown> }) {
      const { action, args = {} } = params;

      const actionDef = ACTIONS[action];
      if (!actionDef) {
        const available = Object.keys(ACTIONS).join(", ");
        return {
          content: [
            { type: "text", text: `Error: Unknown action '${action}'. Available: ${available}` },
          ],
        };
      }

      if (actionDef.required) {
        for (const req of actionDef.required) {
          if (!(req in args)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Missing required arg '${req}' for action '${action}'`,
                },
              ],
            };
          }
        }
      }

      const logger = api.logger;
      logger?.debug?.(`clickup-api: ${action}${args.listId ? ` list=${args.listId}` : ""}${args.taskId ? ` task=${args.taskId}` : ""}${args.spaceId ? ` space=${args.spaceId}` : ""}`);
      try {
        const result = await actionDef.handler(args, config);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger?.error?.(`clickup-api: ${action} failed — ${msg}`);
        return { content: [{ type: "text", text: `ClickUp error: ${msg}` }] };
      }
    },
  };
}
