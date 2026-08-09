import { type AosCommandContext, aosCommand } from "./commands/aos.ts";
import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";

export type ExperimentalCliContext = AosCommandContext & ServerCommandContext & ClientCommandContext;

export const experimentalCli = aosCommand.command(serverCommand).command(clientCommand);
