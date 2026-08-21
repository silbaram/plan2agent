/** Shared supplemental verification command parsing for Plan2Agent CLIs. */

export const VERIFICATION_TYPE_VALUES = Object.freeze([
  'test',
  'lint',
  'typecheck',
  'custom',
]);

const VERIFICATION_TYPES = new Set(VERIFICATION_TYPE_VALUES);
const VERIFICATION_TYPE_GUIDANCE = [
  `Allowed types: ${VERIFICATION_TYPE_VALUES.join(', ')}.`,
  "Use: --verify-command 'custom:npm run build'",
  'No run state or verification evidence was changed.',
].join('\n');

export function isVerificationType(value) {
  return VERIFICATION_TYPES.has(value);
}

export function verificationTypeList() {
  return VERIFICATION_TYPE_VALUES.join(', ');
}

function verificationCommandError(message) {
  return new Error(`${message}\n${VERIFICATION_TYPE_GUIDANCE}`);
}

export function parseVerifyCommand(value) {
  const separator = value.indexOf(':');
  if (separator === -1) {
    throw verificationCommandError('--verify-command must use type:command.');
  }

  const type = value.slice(0, separator).trim();
  if (!type) {
    throw verificationCommandError('--verify-command type must not be blank.');
  }
  if (!isVerificationType(type)) {
    throw verificationCommandError(`Unsupported verification type "${type}".`);
  }

  const command = value.slice(separator + 1);
  if (!command.trim()) {
    throw verificationCommandError('--verify-command command must not be blank.');
  }
  return { type, command, source: 'command' };
}
