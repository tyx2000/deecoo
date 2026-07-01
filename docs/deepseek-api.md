# DeepSeek API Notes

Verified from DeepSeek official API docs on 2026-06-30.

- OpenAI-compatible base URL: `https://api.deepseek.com`
- Authentication: `Authorization: Bearer <api key>`
- Official SDK examples use the environment variable `DEEPSEEK_API_KEY` for the API key.
- Current model names shown in docs: `deepseek-v4-flash`, `deepseek-v4-pro`
- Chat endpoint: `POST /chat/completions`
- Tool/function calling is supported, but the model only returns the requested function call. Local code must execute the function and send the result back.

References:

- https://api-docs.deepseek.com/
- https://api-docs.deepseek.com/guides/function_calling
