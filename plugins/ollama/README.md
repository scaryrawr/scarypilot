# Ollama Plugin

Generate images from text prompts using Ollama's experimental image generation models.

> **⚠️ Note:** Image generation in Ollama is currently experimental and only available on macOS. Windows and Linux support is coming soon.

## What This Plugin Does

- Generates images from natural language prompts using a single helper with backend auto-selection (`cli` or `rest`)
- Supports multiple models: Z-Image Turbo (photorealistic) and FLUX.2 Klein (text rendering)
- Supports rich controls when CLI backend is available (`steps`, `seed`, `negative prompt`)
- Configures image size via `size` or `width`/`height`
- Saves generated images to the current working directory

## Prerequisites

- **macOS** (image generation is not yet supported on Windows or Linux)
- **[Ollama](https://ollama.com/)** must be installed and running
  - Install: `brew install ollama` or download from [ollama.com](https://ollama.com/)
- **[jq](https://jqlang.github.io/jq/)** for JSON parsing
  - Install: `brew install jq`

## Installation

```bash
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install ollama@scarypilot
```

## Usage Examples

**Generate an image with the default model:**

```text
"Generate an image of a sunset over the ocean with dramatic clouds"
```

**Use a specific model:**

```text
"Use FLUX.2 Klein to generate a neon sign reading OPEN 24 HOURS in a rainy alley"
```

**Generate with specific settings:**

```text
"Generate a 1024x1024 portrait photo with seed 42"
```

**Force REST backend (OpenAI-compatible endpoint):**

```text
"Generate an image using the REST backend and save it as sunset.png"
```

**Use richer CLI controls:**

```text
"Use CLI backend with steps 20, seed 42, and a negative prompt to avoid blur"
```

## Resources

- [Ollama Image Generation Blog Post](https://ollama.com/blog/image-generation)
- [Ollama OpenAI Compatibility — Image Generations](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx#v1imagesgenerations-experimental)
- [Z-Image Turbo Model Page](https://ollama.com/x/z-image-turbo)
- [FLUX.2 Klein Model Page](https://ollama.com/x/flux2-klein)
- [Ollama Documentation](https://ollama.com/)
