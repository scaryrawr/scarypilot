# Playwright Extension Plugin

Browser automation for GitHub Copilot using Microsoft's Playwright. Enables web scraping, testing, and form automation by connecting to your existing browser with logged-in sessions.

## What This Plugin Does

Automate browser interactions using [Playwright](https://playwright.dev/):

- Navigate pages, click elements, fill forms, take screenshots
- Work with logged-in sessions in your existing browser
- Extract data from web pages
- Automate testing workflows

## Installation

1. Install [Node.js 18+](https://nodejs.org/)
2. Download and install the [Playwright MCP Bridge extension](https://github.com/microsoft/playwright-mcp/releases/latest) for Microsoft Edge or Chrome
3. Install the plugin:

   ```bash
   copilot plugin marketplace add scaryrawr/scarypilot
   copilot plugin install playwright-ext@scarypilot
   ```

## Usage Examples

**Navigate and interact:**

```text
"Open google.com and search for 'Playwright automation'"
"Fill out the contact form on example.com"
```

**Work with logged-in sessions:**

```text
"Go to my Azure DevOps dashboard and list my active pull requests"
"Check my GitHub notifications"
```

**Extract data:**

```text
"Extract all product names and prices from this page"
"Get the list of issues from this GitHub repository"
```

**Automated testing:**

```text
"Test the login flow on staging.example.com"
"Verify all navigation links work on the homepage"
```

## Resources

- [Playwright MCP Repository](https://github.com/microsoft/playwright-mcp)
- [Playwright Documentation](https://playwright.dev/)
