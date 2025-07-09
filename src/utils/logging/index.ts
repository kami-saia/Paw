/**
 * @fileoverview Main entry point for the compact logging system
 * Provides a default logger instance with Jest environment detection
 */

import { experiments, EXPERIMENT_IDS } from "../../shared/experiments"
import { CompactLogger } from "./CompactLogger"

/**
 * No-operation logger implementation for production environments
 */
const noopLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	fatal: () => {},
	child: () => noopLogger,
	close: () => {},
}

/**
 * Default logger instance
 * Uses CompactLogger for normal operation, switches to noop logger in Jest test environment
 */
export const logger =
	process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development" ? new CompactLogger() : noopLogger
