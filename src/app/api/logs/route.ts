/**
 * API route for log management
 *
 * Handles:
 * - Saving log sessions to disk
 * - Manual log rotation
 * - Log file cleanup
 */

import { NextRequest, NextResponse } from 'next/server';
import { saveSession, rotateLogFiles } from '@/utils/logger-server';
import type { LogSession } from '@/utils/logger';

/**
 * POST /api/logs - Save a logging session to disk
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const session = body.session as LogSession;

    if (!session || !session.sessionId) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid session data',
        },
        { status: 400 }
      );
    }

    // Rotate old log files
    await rotateLogFiles();

    // Save the session
    await saveSession(session);

    return NextResponse.json({
      success: true,
      sessionId: session.sessionId,
    });
  } catch (error) {
    console.error('Failed to save log session:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
