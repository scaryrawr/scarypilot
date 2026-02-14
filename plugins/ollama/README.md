# Ollama Plugin

Generate images from text prompts using Ollama's experimental image generation models.

> **⚠️ Note:** Image generation in Ollama is currently experimental and only available on macOS. Windows and Linux support is coming soon.

## What This Plugin Does

- Generates images from natural language prompts using local Ollama models
- Supports multiple models: Z-Image Turbo (photorealistic) and FLUX.2 Klein (text rendering)
- Configures image size, steps, seed, and negative prompts
- Saves generated images to the current working directory

## Prerequisites

- **macOS** (image generation is not yet supported on Windows or Linux)
- **[Ollama](https://ollama.com/)** must be installed and running
  - Install: `brew install ollama` or download from [ollama.com](https://ollama.com/)

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

## Resources

- [Ollama Image Generation Blog Post](https://ollama.com/blog/image-generation)
- [Z-Image Turbo Model Page](https://ollama.com/x/z-image-turbo)
- [FLUX.2 Klein Model Page](https://ollama.com/x/flux2-klein)
- [Ollama Documentation](https://ollama.com/)
