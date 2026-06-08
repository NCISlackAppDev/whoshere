'use strict';

const { App } = require('@slack/bolt');
const { buildPresenceBlocks } = require('./presence');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: process.env.SLACK_APP_TOKEN ? true : false,
  appToken: process.env.SLACK_APP_TOKEN,
});

// /whoshere [group-handle]
app.command('/whoshere', async ({ command, ack, respond, client }) => {
  await ack();

  const groupHandle = (command.text || '').trim().replace(/^@/, '').toLowerCase();

  if (!groupHandle) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/whoshere <group-handle>` — e.g. `/whoshere captioners`',
    });
    return;
  }

  await respond({
    response_type: 'ephemeral',
    text: `Checking presence for *${groupHandle}*…`,
    replace_original: false,
  });

  try {
    const blocks = await buildPresenceBlocks(client, groupHandle);
    await respond({
      response_type: 'ephemeral',
      replace_original: true,
      blocks,
      text: `Presence roster for ${groupHandle}`,
    });
  } catch (err) {
    console.error(err);
    await respond({
      response_type: 'ephemeral',
      replace_original: true,
      text: err.userMessage || `Could not load presence for *${groupHandle}*. Check the group handle and try again.`,
    });
  }
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`whoshere listening on :${port}`);
})();
