const cache = require("memory-cache");
const AWS = require("aws-sdk");
const cron = require("node-cron");
const fs = require("fs");

// Define AWS accounts
let accountsConfigPath = "config/awsaccounts.json";

const awsAccountsConfig = JSON.parse(fs.readFileSync(accountsConfigPath));

// Load credentials when running in local development environment
if (process.env.ENVIRONMENT === "LOCALDEV") {
  let credentials = new AWS.SharedIniFileCredentials({
    profile: "default",
  });
  AWS.config.credentials = credentials;
}

// Variable to hold AWS accounts and region
const awsAccounts = [];

// Objects to lookup instances / groups against account
let instanceAccountLookup = {};

let initCompleted = false;
let initFailed = false;

/**
 * Anonymous asynchronous function to initialize the module
 */

(async () => {
  try {
    // Setup awsAccounts variable with accounts and regions
    await setupAwsAccounts();

    // Cache instance list
    console.log("Refreshing AWS Instance List");
    await getInstances(true);

    // Refresh instance list every 30 minutes
    cron.schedule("*/30 * * * *", async () => {
      console.log("Refreshing AWS Instance List");
      await getInstances(true);

      console.log("Refreshing Security Group List");
      await cachedSecurityGroupList(true);
    });
  } catch (err) {
    /* Your Error handling goes here */
    console.log(`AWS Module failed to load, message: ${err.message}`);

    initFailed = true;
  }

  initCompleted = true;
})();

/**
 * Wraps an AWS function to handle pagination and throttling when making
 * API calls
 *
 * @param {object} account Account object
 * @param {String} moduleName Name of AWS Module to use
 * @param {String} functionName Name of function from object
 * @param {object} params Parameters for AWS function
 * @param {String} dataKey Name of key data is returned in
 */

async function awsRequestHandler(
  account,
  moduleName,
  functionName,
  params,
  dataKey
) {
  // Load relevant AWS module for account
  const awsModule = new AWS[moduleName]({
    apiVersion: "2016-11-15",
    region: account.region,
    credentials: await getCredentials(account),
  });

  let nextToken = null;
  const result = [];

  do {
    if (nextToken) params.NextToken = nextToken;
    nextToken = null;

    let throttleRetry = false;
    let retryCount = 0;

    do {
      // Retry in case of throttling
      throttleRetry = false;
      try {
        const response =
          (await awsModule[functionName](params).promise()) || {};

        nextToken = response.NextToken || null;

        if (Array.isArray(response[dataKey]))
          response[dataKey].forEach((r) => result.push(r));
      } catch (err) {
        if (err.message === "Rate exceeded") {
          if (err.retryable) {
            if (retryCount++ < 10) {
              console.log(
                `AWS Function ${functionName} throtteled, retry after 2 seconds, try: ${retryCount}`
              );
              throttleRetry = true;
              if (nextToken) await sleep(10000); // Sleep for ten seconds
            } else {
              console.log(
                `Throttle issue with AWS function, maximum retries exceeded: ${functionName}`
              );
              errh.pushError(
                `Throttle issue with AWS function, maximum retries exceeded: ${functionName}`
              );
            }
          } else {
            console.log(`Error with AWS function: ${functionName}`);
            errh.pushError(
              `Error with AWS function (not retryable): ${functionName}, Message: ${err.message}, Stack: ${err.stack}`
            );
          }
        } else {
          console.log(`Error with AWS function: ${functionName}`);
          errh.pushError(
            `Error with AWS function: ${functionName}, Message: ${err.message}, Stack: ${err.stack}`
          );
        }
      }
    } while (throttleRetry);

    if (nextToken) await sleep(500); // wait 500ms, avoid throttling
  } while (nextToken);

  return result;
}

/**
 *
 * Handles calling the AWS assume role API, cached credentials for 55 minutes
 *
 * @param {*} account Object containing account id, display name and region
 * @returns {*} Credentials for assumed role
 */

async function getCredentials(account) {
  let sts = new AWS.STS();

  let params = {
    RoleArn: `arn:aws:iam::${account.id}:role/${account.roleName}`,
    RoleSessionName: `${account.roleName}_session`,
  };

  const cachedName = params.RoleSessionName + params.RoleArn;
  const cachedResultExpireTime = 3300000; // Default session duration is 1 hour, cache for 55mins (in ms)
  const cachedResult = cache.get(cachedName);

  // If there is a cached result then return it
  if (cachedResult) {
    return cachedResult;
  }

  let result;
  let credential;
  try {
    result = await sts.assumeRole(params).promise();

    credential = new AWS.Credentials(
      result.Credentials.AccessKeyId,
      result.Credentials.SecretAccessKey,
      result.Credentials.SessionToken
    );
  } catch (err) {
    console.log(`Failed to load AWS Credentials, Message: ${err.message}`);
    /* Your error handling goes here */
    console.log(
      `Failed to load AWS Credentials, Message: ${err.message}, stack: ${err.stack}`
    );
  }

  cache.put(cachedName, credential, cachedResultExpireTime);

  return credential;
}

/**
 * Populates the awsAccounts variable with details of accounts and regions
 * that contain AWS instances.
 */

async function setupAwsAccounts() {
  for (let i = 0; i < awsAccountsConfig.length; i++) {
    try {
      // Get list of regions with AWS account with EC2 instances
      let regions = await findRegionsWithInstance(awsAccountsConfig[i]);

      // Add an object to the
      for (let j = 0; j < regions.length; j++)
        awsAccounts.push({ ...awsAccountsConfig[i], region: regions[j] });
    } catch (err) {
      /* Your error handling goes here */
      console.log(
        `Error Accessing AWS Account [${awsAccountsConfig[i].name}] - ${err.message}`
      );
    }
  }
}

/**
 *
 * Gets list of regions and returns names of regions were instances are found.
 *
 * @param {*} account Object containing account id & display name
 * @returns {*} Array of regions which contain AWS instances
 */

async function findRegionsWithInstance(account) {
  let validRegions = [];

  const ec2 = new AWS.EC2({
    apiVersion: "2016-11-15",
    region: "eu-west-1",
    credentials: await getCredentials(account),
  });

  // Get list of all regions
  let regionResult = await ec2.describeRegions({}).promise();
  let regionList = regionResult.Regions.map((r) => r.RegionName);

  // for each region, try and fetch instances
  for (let i = 0; i < regionList.length; i++)
    if (await testForInstances(account, regionList[i]))
      validRegions.push(regionList[i]);

  return validRegions;
}

/**
 *
 * Gets list of regions and returns names of regions were instances have been found.
 *
 * @param {*} account Object containing account id & display name
 * @param {*} region Name of region to test
 * @returns {boolean} Returns true if any instances have been found in a region
 *
 */

async function testForInstances(account, region) {
  const ec2 = new AWS.EC2({
    apiVersion: "2016-11-15",
    region: region,
    credentials: await getCredentials(account),
  });

  try {
    // Try list instances
    let instances = await ec2.describeInstances({ MaxResults: 5 }).promise();

    // If any instances are return then return true
    if (instances.Reservations.length > 0) return true;

    return false;
  } catch (err) {
    return false;
  }
}

/**
 * Helper functions to pull data from an AWS account
 */

const dataFunctions = {
  /**
   *
   * Get AWS instances for a given account
   *
   * @param {*} account Object containing account id, display name & region
   * @param {Array} instanceIds Optional list of instance IDs to return
   * @returns {Array} List of instances in account
   */
  getInstances: async (account, instanceIds = null) => {
    let params = {};

    // If instance IDs have been specified, filter to specified instance IDs
    if (instanceIds) {
      params["InstanceIds"] = instanceIds;
    }

    let reservations = await awsRequestHandler(
      account,
      "EC2",
      "describeInstances",
      params,
      "Reservations"
    );

    let instances = [];

    reservations.forEach((r) =>
      r.Instances.forEach((i) => {
        // Convert Tags to Hash Table
        const temporal = {};
        i.Tags.forEach((t) => (temporal[t.Key] = t.Value));
        i.Tags = temporal;

        // Add account name for easy reference
        i["Account"] = account.name;
        i["AccountId"] = account.id;
        i["Region"] = account.region;

        instances.push(i);
      })
    );

    // Update hash table linking instances to accounts
    // used for quickly looking up an individual instance
    instances.forEach((i) => (instanceAccountLookup[i.InstanceId] = account));

    return instances;
  },
};

/**
 *
 * Get list of all instances from each configured account
 * keep data in a cache
 *
 * @param {bool} refreshCache If true force a refresh of the cached instance list
 * @returns {object} list of AWS instances
 */

async function getInstances(refreshCache = false) {
  // Try and retrieve result from memory cache
  const cachedName = "cachedInstanceList";
  const cachedResultExpireTime = 10800000; // Expire after 3 hours (cron updates every 30mins)
  const cachedResult = cache.get(cachedName);

  // If there is a cached result then return it
  if (cachedResult && !refreshCache) {
    return cachedResult;
  }

  // If there is no cache result, fetch a new result
  let result = [];

  for (let i = 0; i < awsAccounts.length; i++) {
    let patchStates = await dataFunctions.getInstances(awsAccounts[i]);
    result = result.concat(patchStates);
  }

  // Add result to memory cache
  console.log("Updated AWS Instances Cache");
  cache.put(cachedName, result, cachedResultExpireTime);

  return result;
}

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

module.exports = {
  initCompleted: () => initCompleted,
  initFailed: () => initFailed,
  getInstances: getInstances,
};
