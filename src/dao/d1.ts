type CreateUserInput = {
  email: string;
  name: string;
};

type UpdateUserInput = {
  name?: string;
  ai_nickname?: string;
};

type User = {
  id: number;
  email: string;
  name: string;
  ai_nickname: string | null;
  created_at: string;
};

export async function createUser(db: D1Database, input: CreateUserInput): Promise<User> {
  const result = await db
    .prepare('INSERT INTO users (email, name) VALUES (?, ?)')
    .bind(input.email, input.name)
    .run();
  const id = result.meta.last_row_id as number;
  const user = await getUser(db, id);
  return user!;
}

export async function getUser(db: D1Database, id: number): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
}

export async function updateUser(db: D1Database, id: number, input: UpdateUserInput): Promise<User> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) {
    sets.push('name = ?');
    values.push(input.name);
  }
  if (input.ai_nickname !== undefined) {
    sets.push('ai_nickname = ?');
    values.push(input.ai_nickname);
  }
  if (sets.length === 0) {
    return (await getUser(db, id))!;
  }
  values.push(id);
  await db
    .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
  return (await getUser(db, id))!;
}
