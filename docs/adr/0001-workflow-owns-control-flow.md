# The workflow owns control flow; LLMs only judge and rewrite prompts

A Run is a deterministic Mastra workflow: code decides when to generate, score, iterate, stop, and which Image Model to call. The Judge and the Optimizer are agents with structured output called from inside steps; no LLM chooses tools or loop control. We chose this over a single tool-calling agent so cost stays bounded by the Budget, Runs can be replayed, and Steering lands at well-defined Iteration boundaries.
