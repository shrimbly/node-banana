/**
 * Centralized logging utility for Node Banana
 *
 * Features:
 * - Session-based logging (one log file per workflow execution)
 * - Automatic rotation (keeps last 10 sessions)
 * - Privacy-aware (truncates prompts, logs image metadata not full data)
 * - Structured JSON format
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogCategory =
  | 'workflow.start'
  | 'workflow.end'
  | 'workflow.error'
  | 'workflow.validation'
  | 'node.execution'
  | 'node.error'
  | 'api.gemini'
  | 'api.openai'
  | 'api.llm'
  | 'api.error'
  | 'file.save'
  | 'file.load'
  | 'file.error'
  | 'connection.validation'
  | 'state.change'
  | 'system';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  context?: Record<string, any>;
  error?: {
    message: string;
    stack?: string;
    name?: string;
  };
}

export interface LogSession {
  sessionId: string;
  startTime: string;
  endTime?: string;
  entries: LogEntry[];
}

// Type for server-only operations
type LoggerServer = {
  saveSession: (session: LogSession) => Promise<void>;
  rotateLogFiles: () => Promise<void>;
};

class Logger {
  private currentSession: LogSession | null = null;
  private isClient: boolean;

  constructor() {
    this.isClient = typeof window !== 'undefined';
  }

  /**
   * Initialize a new logging session for a workflow execution
   * Note: On client side, this just tracks in memory. File writing happens server-side in API routes.
   */
  async startSession(): Promise<string> {
    const sessionId = this.generateSessionId();
    const startTime = new Date().toISOString();

    this.currentSession = {
      sessionId,
      startTime,
      entries: [],
    };

    this.log('info', 'system', `Session started: ${sessionId}`);

    return sessionId;
  }

  /**
   * End the current session
   * Note: On client side, this just clears memory. File writing happens server-side in API routes.
   */
  async endSession(): Promise<void> {
    if (!this.currentSession) {
      return;
    }

    this.currentSession.endTime = new Date().toISOString();
    this.log('info', 'system', `Session ended: ${this.currentSession.sessionId}`);

    this.currentSession = null;
  }

  /**
   * Get the current session (useful for server-side code to save it)
   */
  getCurrentSession(): LogSession | null {
    return this.currentSession;
  }

  /**
   * Log a message
   */
  log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    context?: Record<string, any>,
    error?: Error
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
    };

    if (context) {
      entry.context = this.sanitizeContext(context);
    }

    if (error) {
      entry.error = {
        message: error.message,
        stack: error.stack,
        name: error.name,
      };
    }

    // Add to current session if exists
    if (this.currentSession) {
      this.currentSession.entries.push(entry);
    }

    // Also log to console for development
    const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[consoleMethod](`[${category}] ${message}`, context || '', error || '');
  }

  /**
   * Convenience methods
   */
  info(category: LogCategory, message: string, context?: Record<string, any>): void {
    this.log('info', category, message, context);
  }

  warn(category: LogCategory, message: string, context?: Record<string, any>): void {
    this.log('warn', category, message, context);
  }

  error(category: LogCategory, message: string, context?: Record<string, any>, error?: Error): void {
    this.log('error', category, message, context, error);
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.currentSession?.sessionId || null;
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const random = Math.random().toString(36).substring(2, 8);
    return `exec-${timestamp}-${random}`;
  }

  /**
   * Sanitize context to protect privacy and reduce log size
   */
  private sanitizeContext(context: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(context)) {
      // Truncate prompts to 200 characters
      if (key === 'prompt' && typeof value === 'string') {
        sanitized[key] = value.length > 200 ? value.substring(0, 200) + '...[truncated]' : value;
      }
      // Convert image data URIs to metadata
      else if (key === 'image' || key === 'images') {
        if (typeof value === 'string' && value.startsWith('data:image')) {
          sanitized[key] = this.extractImageMetadata(value);
        } else if (Array.isArray(value)) {
          sanitized[key] = value.map(img =>
            typeof img === 'string' && img.startsWith('data:image')
              ? this.extractImageMetadata(img)
              : img
          );
        } else {
          sanitized[key] = value;
        }
      }
      // Handle nested objects
      else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        sanitized[key] = this.sanitizeContext(value);
      }
      // Keep other values as-is
      else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Extract metadata from image data URI
   */
  private extractImageMetadata(dataUri: string): object {
    const match = dataUri.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
      return { error: 'Invalid image data URI' };
    }

    const [, format, base64Data] = match;
    const sizeInBytes = base64Data.length * 0.75; // Approximate size from base64
    const sizeInKB = Math.round(sizeInBytes / 1024);

    return {
      format,
      sizeKB: sizeInKB,
      isDataURI: true,
    };
  }

}

// Export singleton instance
export const logger = new Logger();
