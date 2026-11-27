# Security

own-open-code is a personal project, shared as is and without support. It has no security contact: issues, pull
requests and private vulnerability reports are turned off for this repository.

It is not affiliated with the OpenCode team, and their security contacts do not handle this fork. A problem that also
exists in upstream OpenCode belongs to them; see
[their security policy](https://github.com/anomalyco/opencode/blob/dev/SECURITY.md).

What to know before you use it:

- The agent is not sandboxed. Approval prompts show you what it does; they are not isolation.
- Account credentials stay on your PC (Windows DPAPI). The remote access gateway and the app listener are off by
  default and listen on 127.0.0.1; another device needs a pairing approved on the PC.
- Some account connections are unofficial and may break a provider's terms (README, "Use at your own risk").
