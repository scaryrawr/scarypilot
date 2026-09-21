import { joinSession } from "@github/copilot-sdk/extension";
import { createPstackExtensionRegistration } from "./register.ts";

const registration = createPstackExtensionRegistration();

const session = await joinSession(registration.options);

registration.attachSession(session);
