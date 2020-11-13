# Multiple AWS Accounts with Node.js and AWS-SDK

In this example code we access multiple accounts from a single authentication by assuming a role cross account.

## Pre-requisites

- Node.js with NPM
- AWS CLI

## Basic Usage

### 1. Create AWS Roles

An IAM role is required in each AWS account that reports reports will be pulled from, create a role with the following details:

Attach a policy to the role for EC2 describe access:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": ["ec2:Describe*"],
      "Effect": "Allow",
      "Resource": "*"
    }
  ]
}
```

Add a trust relationship to the role as follows:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": ["arn:aws:iam::000000000001:role/YourAWSRole"]
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

Update the line:

"arn:aws:iam::`000000000001`:role/`YourAWSRole`"

So that `000000000001` is replaced with the account you will use to authenticate AWS, and `YourAWSRole` is replaced with the role name.

### 2. Create `config/awsaccounts.json`

| Parameter | Description                                                                   |
| --------- | ----------------------------------------------------------------------------- |
| name      | A display name for the target AWS Account                                     |
| id        | The AWS account ID                                                            |
| roleName  | The role you have published to each account to grant access to AWS resources. |

Example:

```json
[
  {
    "name": "Account1",
    "id": "000000000001",
    "roleName": "Reporting"
  },
  {
    "name": "Account2",
    "id": "000000000002",
    "roleName": "Reporting"
  }
]
```

The `roleName` will match the name of the roles created in step 1.

### 3. Create `.env` file

Create a file named `.env` in the root of the project with the following:

```dotenv
ENVIRONMENT=LOCALDEV
AWS_SDK_LOAD_CONFIG=1
```

### 4. Download Node.js Modules

Rune the following in the project root folder:

```bash
npm install
```

### 5. Authenticate to AWS

Use the AWS Command line to authenticate to AWS, this example uses the default profile, this can be changed in `line 14` of `aws.js`.

[AWS CLI Guide](https://docs.aws.amazon.com/cli/latest/reference/configure/index.html)

### 4. Run the example

Run the example using:

```bash
node example.js
```

This will describe all AWS instances across each configured account and output to the cli.
