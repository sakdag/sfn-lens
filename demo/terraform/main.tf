terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}

data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${path.module}/lambda/handler.py"
  output_path = "${path.module}/lambda.zip"
}

resource "aws_iam_role" "lambda" {
  name = "${var.project_name}-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "demo" {
  function_name    = "${var.project_name}-fn"
  role             = aws_iam_role.lambda.arn
  handler          = "handler.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 3
  memory_size      = 128
}

resource "aws_iam_role" "sfn" {
  name = "${var.project_name}-sfn"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "states.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "sfn_lambda" {
  name = "${var.project_name}-invoke"
  role = aws_iam_role.sfn.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.demo.arn]
    }]
  })
}

locals {
  definition = {
    Comment = "sfn-lens demo — cheap fault-injection workflow"
    StartAt = "Validate"
    States = {
      Validate = {
        Type     = "Task"
        Resource = aws_lambda_function.demo.arn
        Parameters = {
          step     = "validate"
          "fault.$" = "$.fault"
        }
        Next = "Route"
      }
      Route = {
        Type = "Choice"
        Choices = [{
          Variable     = "$.fault"
          StringEquals = "reject"
          Next         = "Reject"
        }]
        Default = "MaybeMap"
      }
      MaybeMap = {
        Type = "Choice"
        Choices = [{
          Variable     = "$.fault"
          StringEquals = "map_partial"
          Next         = "ProcessMap"
        }]
        Default = "Process"
      }
      ProcessMap = {
        Type           = "Map"
        ItemsPath      = "$.items"
        MaxConcurrency = 2
        Iterator = {
          StartAt = "MapItem"
          States = {
            MapItem = {
              Type     = "Task"
              Resource = aws_lambda_function.demo.arn
              Parameters = {
                step      = "map_item"
                "item.$"  = "$"
              }
              End = true
            }
          }
        }
        Next = "Done"
      }
      Process = {
        Type     = "Task"
        Resource = aws_lambda_function.demo.arn
        Parameters = {
          step      = "process"
          "fault.$" = "$.fault"
        }
        Retry = [{
          ErrorEquals     = ["States.ALL"]
          IntervalSeconds = 1
          MaxAttempts     = 2
          BackoffRate     = 1.5
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "HandleError"
          ResultPath  = "$.error"
        }]
        Next = "Done"
      }
      HandleError = {
        Type = "Choice"
        Choices = [{
          Variable     = "$.fault"
          StringEquals = "caught_then_fail"
          Next         = "FailAfterCatch"
        }]
        Default = "Done"
      }
      FailAfterCatch = {
        Type  = "Fail"
        Error = "CaughtThenFailed"
        Cause = "recovered from task error then failed deliberately"
      }
      Reject = {
        Type  = "Fail"
        Error = "Rejected"
        Cause = "validation rejected"
      }
      Done = {
        Type = "Succeed"
      }
    }
  }
}

resource "aws_sfn_state_machine" "demo" {
  name       = var.project_name
  role_arn   = aws_iam_role.sfn.arn
  definition = jsonencode(local.definition)
}

output "state_machine_arn" {
  value = aws_sfn_state_machine.demo.arn
}

output "lambda_arn" {
  value = aws_lambda_function.demo.arn
}

output "region" {
  value = var.aws_region
}
