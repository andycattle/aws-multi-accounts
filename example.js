const { initFailed } = require("./aws");
const aws = require("./aws");

require("dotenv").config();

(async () => {
  // wait for module to finish loading
  while (!(aws.initCompleted() || aws.initFailed())) await sleep(500);

  if (aws.initFailed()) {
    console.log("Failed to load AWS Module");
    process.exit(1);
  }

  const instances = aws.getInstances();

  console.log(instances);

  process.exit(0);
})();

/**
 *
 * Sleep function for use in asynchronous functions, wraps
 * setTimeout in a promise.
 *
 * @param {int} delay Time in ms to wait
 */
async function sleep(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}
