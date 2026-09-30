import { appTasks, OhosAppContext, OhosPluginId } from '@ohos/hvigor-ohos-plugin';
import { getNode, HvigorNode } from '@ohos/hvigor';
import * as fs from 'fs';
import * as path from 'path';

// Signing stays out of the repository: build-profile.json5 has no signing config, and a
// local, git-ignored signing.local.json (see scripts/move-signing.mjs) is applied here.
getNode(__filename).afterNodeEvaluate((node: HvigorNode) => {
  const file = path.join(__dirname, 'signing.local.json');
  if (!fs.existsSync(file)) return;
  const context = node.getContext(OhosPluginId.OHOS_APP_PLUGIN) as OhosAppContext;
  const profile = context.getBuildProfileOpt();
  profile.app.signingConfigs = JSON.parse(fs.readFileSync(file, 'utf8')).signingConfigs;
  context.setBuildProfileOpt(profile);
});

export default {
  system: appTasks /* Built-in plugin of Hvigor. It cannot be modified. */,
  plugins: [] /* Custom plugin to extend the functionality of Hvigor. */,
};
