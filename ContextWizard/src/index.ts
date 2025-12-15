import { Probot } from "probot";
import { setupHandlers } from "./handlers.js";

export default (app: Probot) => {
  setupHandlers(app);
};