/** Self-hosted instance admins need no extra configuration for update controls. */
export function canAccessPlatformAdmin(input: {
  deploymentMode: string;
  instanceRole: string;
  email: string;
  allowedEmails: string[];
}) {
  if (input.allowedEmails.length > 0) return input.allowedEmails.includes(input.email.toLowerCase());
  return input.deploymentMode === "self-hosted" && input.instanceRole === "instance_admin";
}
