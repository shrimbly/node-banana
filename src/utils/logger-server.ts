/**
 * Server-side only logger utilities
 * This file should never be imported on the client side
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { LogSession } from './logger';

/**
 * Save session to file (server-side only)
 */
export async function saveSession(session: LogSession): Promise<void> {
  const logsDir = path.join(process.cwd(), 'logs');
  const filename = `session-${session.sessionId}.json`;
  const filepath = path.join(logsDir, filename);

  // Ensure logs directory exists
  try {
    await fs.mkdir(logsDir, { recursive: true });
  } catch (error) {
    console.error('Failed to create logs directory:', error);
    return;
  }

  // Write session to file
  try {
    await fs.writeFile(filepath, JSON.stringify(session, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to write log file:', error);
  }
}

/**
 * Rotate log files (keep only last 10 sessions)
 */
export async function rotateLogFiles(): Promise<void> {
  const logsDir = path.join(process.cwd(), 'logs');

  // Ensure logs directory exists
  try {
    await fs.mkdir(logsDir, { recursive: true });
  } catch (error) {
    console.error('Failed to create logs directory:', error);
    return;
  }

  // Get all log files
  let files: string[];
  try {
    files = await fs.readdir(logsDir);
  } catch (error) {
    console.error('Failed to read logs directory:', error);
    return;
  }

  // Filter to only session log files
  const sessionFiles = files
    .filter(f => f.startsWith('session-') && f.endsWith('.json'))
    .sort()
    .reverse(); // Most recent first

  // Delete files beyond the 10 most recent
  const filesToDelete = sessionFiles.slice(10);
  for (const file of filesToDelete) {
    try {
      await fs.unlink(path.join(logsDir, file));
      console.log(`Deleted old log file: ${file}`);
    } catch (error) {
      console.error(`Failed to delete log file ${file}:`, error);
    }
  }
}
