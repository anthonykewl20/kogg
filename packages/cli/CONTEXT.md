# Terminal Client

The Terminal Client context describes how terminal users establish and inspect provider access and select models for the Qwen Code Agent Runtime.

## Language

**Authentication Surface**:
The terminal interactions through which a user establishes or replaces a Provider Session.
_Avoid_: login command, provider runtime

**Browser-callback Login**:
An interactive login that returns authorization to the local Terminal Client through a browser callback.
_Avoid_: device login

**Device-code Login**:
An interactive login completed in a separate browser using a short-lived user code, suitable for headless and remote terminals.
_Avoid_: browser callback

**Account Switch**:
Replacement of the active Provider Session through a fresh authentication flow.
_Avoid_: multi-account selection
