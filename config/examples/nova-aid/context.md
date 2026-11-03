# Nova Aid agent context

Copy this file and `config.json` into `<Nova aid folder>/.dev-agent/` (as `context.md` and `config.json`).
Paths in `config.json` are relative to the Nova aid folder. Also read the `nova-aid` skill for ownership,
contract ripple and auth.

## Deciding which repos change
- The server (api-server) is the source of truth. If it already returns what the ticket needs, plan the panel only.
- A contract change (route, shape, permission name, socket event) means api-server first, then each caller repo.
- A new permission needs the server seeder and the agent-panel `PERMISSIONS` constant.

## Manual checks
Anything that needs `.env`, MongoDB, RabbitMQ, Redis or a running server is a manual check for the developer.

## landing-website
No task-to-pr skill yet. Use `/nova-aid` skill file 08 and `STANDARDS.md` until one exists.

## Interface for dependents
api-server reports routes (method, path, permission), request and response shapes, socket event names, new
permissions or seeder steps, and env or config keys.
