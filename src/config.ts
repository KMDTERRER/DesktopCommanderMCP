import path from 'path';
import os from 'os';
import { PROCESS_WAIT_DEFAULT_MS } from './utils/process-wait-contract.js';

// Use user's home directory for configuration files
export const USER_HOME = os.homedir();
const CONFIG_DIR = path.join(USER_HOME, '.claude-server-commander');

// Paths relative to the config directory
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const TOOL_CALL_FILE = path.join(CONFIG_DIR, 'claude_tool_call.log');
export const TOOL_CALL_FILE_MAX_SIZE = 1024 * 1024 * 10; // 10 MB

export const DEFAULT_COMMAND_TIMEOUT = PROCESS_WAIT_DEFAULT_MS;
