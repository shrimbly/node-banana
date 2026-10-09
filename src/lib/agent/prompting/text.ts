import type { ModalityGuide } from "./types";

export const TEXT_GUIDE: ModalityGuide = {
  modality: "text",
  intro:
    "LLM Generate has no system prompt and node comments never reach it: the Prompt connected to it is the LLM's whole instruction. Write it as a task with its input, and say exactly what to return.",
  tasks: [
    {
      id: "instruction",
      label: "give the LLM a task",
      slots: [
        { name: "Task", required: true, hint: "one verb-first sentence: \"Write\", \"Summarise\", \"List\", \"Translate\"" },
        { name: "Input", required: true, hint: "the idea or text to work on, set apart after a colon or in quotes; when another node supplies it, say so" },
        { name: "Constraints", hint: "length, tone, language, audience, things to include or leave out" },
        { name: "Output format", required: true, hint: "exactly what to return; end with \"Reply with only …\"" },
      ],
      length: "2-5 sentences",
      rules: [
        "When the user later changes the idea, replace only the input and keep the instruction.",
        "When the reply feeds an Array, ask for the items separated by the Array's delimiter (or one per line for splitMode newline) and nothing else.",
      ],
      example: {
        request: "names for a coffee brand",
        weak: "coffee brand names",
        strong:
          "Suggest five names for a small-batch coffee roaster in Melbourne that sells online. Each name is one or two words, easy to say, and not an existing big brand. Reply with only the names, separated by \"*\".",
      },
    },
    {
      id: "prompt-writer",
      label: "have the LLM write a prompt for another node",
      slots: [
        { name: "Task", required: true, hint: "\"Write one prompt for <the target model's job>\"" },
        { name: "What the prompt needs", required: true, hint: "the target guide's slots and length, listed for the LLM (shown below when you pass target)" },
        { name: "Input", required: true, hint: "the user's idea, or a note that it comes from the connected text" },
        { name: "Output format", required: true, hint: "\"Reply with only the prompt.\"" },
      ],
      length: "3-6 sentences",
      example: {
        request: "an LLM that turns ideas into image prompts",
        weak: "Make an image prompt for: a bicycle",
        strong:
          "Write one detailed prompt for an image model. Cover, in this order: the subject and its details, the setting and time of day, composition and camera angle, lighting, and the style or medium, in 1-3 sentences of 30-80 words. The idea: a red bicycle leaning on a brick wall. Reply with only the prompt.",
      },
    },
  ],
  rules: ["Give the LLM its own job only: rules for the agent (tools, the canvas) mean nothing to it."],
  avoid: "Say what to leave out in the Constraints, plainly (\"no hashtags, no emoji\").",
};
