const env = require("./config/env");
const app = require("./app");

app.listen(env.PORT, () => {
  console.log(`Portal API listening on :${env.PORT}`);
});
