import { createTask, listTasks, updateTask, deleteTask, listDocuments, deleteDocument, getChunkIdsByDoc, insertChatMemory, updateChatMemory, getExpiresAt } from '../dao/d1';
import { serperSearch, fetchUrl } from '../services/web';
import { chunksSearch } from '../services/search';
import { log } from '../services/logger';

export type ToolDef = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

export type ToolDeps = {
  d1: D1Database;
  userId: number;
  qdrant: any;
  embedding: any;
  serperApiKey: string;
  files: R2Bucket;
};

export function getToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: 'task_create',
        description: 'Create a new task',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Task title' },
            description: { type: 'string', description: 'Task description' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Task priority' },
          },
          required: ['title'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'task_list',
        description: 'List tasks for the current user',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'], description: 'Filter by status' },
            limit: { type: 'number', description: 'Maximum number of tasks to return' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'task_update',
        description: 'Update an existing task',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Task ID' },
            title: { type: 'string', description: 'New title' },
            description: { type: 'string', description: 'New description' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'], description: 'New status' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'New priority' },
          },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'task_delete',
        description: 'Delete a task',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Task ID' },
          },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web using Google',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Search query' },
          },
          required: ['q'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'Fetch and extract text content from a URL',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to fetch' },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'file_list',
        description: 'List uploaded documents for the current user',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'file_delete',
        description: 'Delete an uploaded document and its chunks',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Document ID' },
          },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'chunks_search',
        description: 'Search document chunks using keyword, vector, or hybrid mode',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            mode: { type: 'string', enum: ['keyword', 'vector', 'hybrid'], description: 'Search mode (default: hybrid)' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'memory_save',
        description: 'Save important user information to long-term memory. Use when user shares preferences, facts, or plans worth remembering for future conversations.',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string', description: 'Complete, pronoun-free sentence with full context' },
                  category: { type: 'string', enum: ['preference', 'fact', 'plan'], description: 'Category: preference (habits/style), fact (identity/info), plan (intentions/schedule)' },
                },
                required: ['content', 'category'],
              },
              minItems: 1,
              maxItems: 5,
              description: 'Memory items to save (1-5 items)',
            },
          },
          required: ['items'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'spawn_agent',
        description: 'Spawn 1-3 sub-agents to execute tasks in parallel. Each sub-agent has isolated context and can use search/file tools. Returns results for each task.',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 3,
              description: 'Task descriptions for sub-agents (1-3 tasks)',
            },
            context: {
              type: 'string',
              description: 'Optional shared context to pass to all sub-agents (e.g., background info, constraints)',
            },
          },
          required: ['tasks'],
        },
      },
    },
  ];
}

export function getSubAgentToolDefinitions(): ToolDef[] {
  return getToolDefinitions().filter((t) => t.function.name !== 'spawn_agent');
}

async function do_task_create(args: any, deps: ToolDeps): Promise<string> {
  const task = await createTask(deps.d1, {
    userId: deps.userId,
    title: args.title,
    description: args.description,
    priority: args.priority,
  });
  return JSON.stringify(task);
}

async function do_task_list(args: any, deps: ToolDeps): Promise<string> {
  const tasks = await listTasks(deps.d1, deps.userId, args.status);
  return JSON.stringify(tasks);
}

async function do_task_update(args: any, deps: ToolDeps): Promise<string> {
  const { id, ...fields } = args;
  const task = await updateTask(deps.d1, id, fields);
  return JSON.stringify(task);
}

async function do_task_delete(args: any, deps: ToolDeps): Promise<string> {
  const deleted = await deleteTask(deps.d1, args.id);
  return JSON.stringify({ deleted });
}

async function do_web_search(args: any, deps: ToolDeps): Promise<string> {
  const results = await serperSearch(args.q, deps.serperApiKey);
  return JSON.stringify(results);
}

async function do_web_fetch(args: any, deps: ToolDeps): Promise<string> {
  return fetchUrl(args.url);
}

async function do_file_list(args: any, deps: ToolDeps): Promise<string> {
  const docs = await listDocuments(deps.d1, deps.userId);
  return JSON.stringify(docs);
}

async function do_file_delete(args: any, deps: ToolDeps): Promise<string> {
  const { getDocument } = await import('../dao/d1');
  const doc = await getDocument(deps.d1, args.id);
  const chunkIds = await getChunkIdsByDoc(deps.d1, args.id);
  const deleted = await deleteDocument(deps.d1, args.id);
  if (deleted && chunkIds.length > 0) {
    await deps.qdrant.deleteByChunkIds(chunkIds);
  }
  if (deleted && doc?.r2_key) {
    await deps.files.delete(doc.r2_key);
  }
  return JSON.stringify({ deleted });
}

async function do_chunks_search(args: any, deps: ToolDeps): Promise<string> {
  const mode = args.mode ?? 'hybrid';
  const results = await chunksSearch(args.query, deps.userId, mode, {
    d1: deps.d1,
    qdrant: deps.qdrant,
    embedding: deps.embedding,
  });
  return JSON.stringify(results);
}

async function do_memory_save(args: any, deps: ToolDeps): Promise<string> {
  const items: { content: string; category: string }[] = args.items;
  if (!items || items.length === 0) return JSON.stringify({ error: 'No items to save' });

  const saved = [];
  for (const item of items) {
    try {
      const [vec] = await deps.embedding.embed([item.content]);
      const existing = await deps.qdrant.searchVectors(vec, deps.userId, 3);
      const duplicate = existing.find((r: any) => r.payload.source === 'chat' && r.score > 0.85);
      const expiresAt = getExpiresAt(item.category);

      if (duplicate) {
        const existingId = duplicate.payload.chunk_id as number;
        await updateChatMemory(deps.d1, existingId, { content: item.content, category: item.category });
        await deps.qdrant.upsertVectors([{
          id: existingId,
          vector: vec,
          payload: { chunk_id: existingId, user_id: deps.userId, source: 'chat', content: item.content, category: item.category, expires_at: expiresAt },
        }]);
        saved.push({ content: item.content, status: 'updated' });
        continue;
      }

      const chunk = await insertChatMemory(deps.d1, {
        userId: deps.userId,
        content: item.content,
        category: item.category,
      });

      await deps.qdrant.upsertVectors([{
        id: chunk!.id,
        vector: vec,
        payload: { chunk_id: chunk!.id, user_id: deps.userId, source: 'chat', content: item.content, category: item.category, expires_at: expiresAt },
      }]);
      saved.push({ content: item.content, status: 'saved' });
    } catch (err: any) {
      saved.push({ content: item.content, status: 'error', error: err.message ?? String(err) });
    }
  }

  log.info('agent:memory_save', 'saved memories', { count: saved.length, statuses: saved.map(s => s.status) });
  return JSON.stringify(saved);
}

const handlers: Record<string, (args: any, deps: ToolDeps) => Promise<string>> = {
  task_create: do_task_create,
  task_list: do_task_list,
  task_update: do_task_update,
  task_delete: do_task_delete,
  web_search: do_web_search,
  web_fetch: do_web_fetch,
  file_list: do_file_list,
  file_delete: do_file_delete,
  chunks_search: do_chunks_search,
  memory_save: do_memory_save,
};

export async function dispatchTool(name: string, args: any, deps: ToolDeps): Promise<string> {
  log.info('agent:dispatchTool', 'tool call', { name, args });

  const handler = handlers[name];
  if (!handler) {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }

  try {
    return await handler(args, deps);
  } catch (err: any) {
    return JSON.stringify({ error: err.message ?? String(err) });
  }
}
