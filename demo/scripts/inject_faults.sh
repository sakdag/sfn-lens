#!/usr/bin/env bash
# Start demo executions for each fault type. Requires AWS_PROFILE=personal.
set -euo pipefail

PROFILE="${AWS_PROFILE:-personal}"
REGION="${AWS_REGION:-eu-north-1}"
ARN="${STATE_MACHINE_ARN:?Set STATE_MACHINE_ARN from terraform output}"

start() {
  local name="$1"
  local input="$2"
  aws --profile "$PROFILE" --region "$REGION" stepfunctions start-execution \
    --state-machine-arn "$ARN" \
    --name "${name}-$(date +%s)" \
    --input "$input" \
    --query 'executionArn' \
    --output text
}

echo "F1 lambda_error: $(start f1 '{"fault":"lambda_error"}')"
echo "F2 timeout:      $(start f2 '{"fault":"timeout"}')"
echo "F3 throttle:     $(start f3 '{"fault":"throttle"}')"
echo "F4 map_partial:  $(start f4 '{"fault":"map_partial","items":[{"id":1},{"id":2,"fail":true},{"id":3}]}')"
echo "F5 caught_then_fail: $(start f5 '{"fault":"caught_then_fail"}')"
echo "F6 reject:       $(start f6 '{"fault":"reject"}')"
echo "OK success:      $(start ok '{"fault":"none"}')"
