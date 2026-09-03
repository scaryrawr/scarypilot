# Prerequisites

The Copilot CLI needs plugin extension support. Install GitHub CLI and the
`ado-codespaces` extension, then authenticate it for the Azure DevOps
organization and GitHub account that own the target work.

Call `codespaces_list` after the plugin loads. The tool starts the supervisor.
If startup fails, fix the GitHub CLI installation, extension installation, or
authentication before you start work.
