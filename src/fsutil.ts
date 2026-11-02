import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function appendText(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, 'a');
  try {
    await handle.appendFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
