'use strict';

const path = require('path');
const fs = require('fs');
const gql = require('graphql-tag');
const jwtDecode = require('jwt-decode');
const BbPromise = require('bluebird');
const fsExtra = require('../../utils/fs/fse');
const fetch = require('node-fetch');
const configUtils = require('../../utils/config');
const functionInfoUtils = require('../../utils/functionInfoUtils');
const createApolloClient = require('../../utils/createApolloClient');

// NOTE Needed for apollo to work
global.fetch = fetch;

const config = {
  PLATFORM_FRONTEND_BASE_URL: 'https://platform.serverless.com/',
  GRAPHQL_ENDPOINT_URL: 'https://graphql.serverless.com/graphql',
};

function addReadme(attributes, readmePath) {
  if (fs.existsSync(readmePath)) {
    const readmeContent = fsExtra.readFileSync(readmePath).toString('utf8');
    // eslint-disable-next-line no-param-reassign
    attributes.readme = readmeContent;
  }
  return attributes;
}

function fetchEndpoint(provider, stage, region) {
  return provider
    .request(
      'CloudFormation',
      'describeStacks',
      { StackName: provider.naming.getStackName(stage) },
      stage,
      region
    )
    .then(result => {
      let endpoint = null;

      if (result) {
        result.Stacks[0].Outputs
          .filter(x => x.OutputKey.match(provider.naming.getServiceEndpointRegex()))
          .forEach(x => {
            endpoint = x.OutputValue;
          });
      }

      return endpoint;
    });
}

class Platform {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider('aws');
    // NOTE for the time being we only track services published to AWS
    if (this.provider) {
      this.hooks = {
        'after:deploy:deploy': this.publishService.bind(this),
      };
    }
  }

  publishServiceRequest(service, client) {
    return client
      .mutate({
        mutation: gql`
        mutation publishService($service: ServicePublishInputType!) {
          publishService(service: $service) {
            name
          }
        }
      `,
        variables: { service },
      })
      .then(response => response.data);
  }

  getAuthToken() {
    if (process.env.SERVERLESS_TOKEN) {
      return process.env.SERVERLESS_TOKEN;
    }

    const userConfig = configUtils.getConfig();
    const currentId = userConfig.userId;
    const globalConfig = configUtils.getGlobalConfig();
    if (globalConfig.users && globalConfig.users[currentId] && globalConfig.users[currentId].auth) {
      return globalConfig.users[currentId].auth.id_token;
    }
    return null;
  }

  publishService() {
    const authToken = this.getAuthToken();
    if (!authToken) {
      // NOTE publishService is an opt-in feature and no warning is needed
      return BbPromise.resolve();
    }
    this.serverless.cli.log('Publish service to Serverless Platform...');

    const clientWithAuth = createApolloClient(config.GRAPHQL_ENDPOINT_URL, authToken);

    const region = this.serverless.service.provider.region;
    const stage = this.serverless.processedInput.options.stage;

    return this.provider.getAccountId().then(accountId =>
      fetchEndpoint(this.provider, stage, region).then(endpoint => {
        const funcs = this.serverless.service.getAllFunctions().map(key => {
          const arnName = functionInfoUtils.aws.getArnName(key, this.serverless);
          let funcAttributes = {
            name: key,
            runtime: functionInfoUtils.aws.getRuntime(key, this.serverless),
            memory: functionInfoUtils.aws.getMemorySize(key, this.serverless),
            timeout: functionInfoUtils.aws.getTimeout(key, this.serverless),
            provider: this.serverless.service.provider.name,
            originId: `arn:aws:lambda:${region}:${accountId}:function:${arnName}`,
            endpoints: functionInfoUtils.aws.getEndpoints(key, this.serverless, endpoint),
          };
          if (this.serverless.service.functions[key].readme) {
            funcAttributes = addReadme(
              funcAttributes,
              this.serverless.service.functions[key].readme
            );
          }
          if (this.serverless.service.functions[key].description) {
            funcAttributes.description = this.serverless.service.functions[key].description;
          }
          return funcAttributes;
        });
        const serviceData = {
          name: this.serverless.service.service,
          stage: this.serverless.processedInput.options.stage,
          functions: funcs,
        };
        if (this.serverless.service.serviceObject.description) {
          serviceData.description = this.serverless.service.serviceObject.description;
        }
        if (this.serverless.service.serviceObject.license) {
          serviceData.license = this.serverless.service.serviceObject.license;
        }
        if (this.serverless.service.serviceObject.bugs) {
          serviceData.bugs = this.serverless.service.serviceObject.bugs;
        }
        if (this.serverless.service.serviceObject.repository) {
          serviceData.repository = this.serverless.service.serviceObject.repository;
        }
        if (this.serverless.service.serviceObject.homepage) {
          serviceData.homepage = this.serverless.service.serviceObject.homepage;
        }

        // NOTE can be improved by making sure it captures multiple variations
        // of readme file name e.g. readme.md, readme.txt, Readme.md
        const readmePath = path.join(this.serverless.config.servicePath, 'README.md');
        const serviceDataWithReadme = addReadme(serviceData, readmePath);

        return this.publishServiceRequest(serviceDataWithReadme, clientWithAuth)
          .then(() => {
            const username = jwtDecode(authToken).nickname;
            const serviceName = this.serverless.service.service;
            const url = `${config.PLATFORM_FRONTEND_BASE_URL}services/${username}/${serviceName}`;
            this.serverless.cli.log(`Your service is available at ${url}`);
          })
          .catch(error => {
            this.serverless.cli.log(
              "Couldn't publish this deploy information to the Serverless Platform due: \n",
              error
            );
          });
      })
    );
  }
}

module.exports = Platform;
