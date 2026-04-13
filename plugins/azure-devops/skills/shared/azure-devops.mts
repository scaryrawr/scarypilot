export type NormalizedAzureDevOpsOrganization = {
  organization: string;
  organizationUrl: string;
};

export function normalizeAzureDevOpsOrganization(value: string): NormalizedAzureDevOpsOrganization {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    throw new Error('Azure DevOps organization cannot be empty');
  }

  if (trimmedValue.startsWith('http://') || trimmedValue.startsWith('https://')) {
    const parsed = new URL(trimmedValue);
    if (parsed.hostname === 'dev.azure.com') {
      const [organization] = parsed.pathname.split('/').filter(Boolean);
      if (!organization) {
        throw new Error(`Could not determine organization from ${trimmedValue}`);
      }
      return { organization, organizationUrl: `https://dev.azure.com/${organization}` };
    }

    if (parsed.hostname.endsWith('.visualstudio.com')) {
      const organization = parsed.hostname.replace(/\.visualstudio\.com$/, '');
      return { organization, organizationUrl: `https://dev.azure.com/${organization}` };
    }

    throw new Error(`Unsupported Azure DevOps organization URL: ${trimmedValue}`);
  }

  return { organization: trimmedValue, organizationUrl: `https://dev.azure.com/${trimmedValue}` };
}
