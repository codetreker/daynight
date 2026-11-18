package task

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	wire "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

func TestBlockedAliasAdmissionRetainsLegacyBudget(t *testing.T) {
	for _, value := range []string{"true", "false"} {
		for _, mode := range []string{"rest", "mcp", "mcp-batch"} {
			t.Run(value+"/"+mode, func(t *testing.T) {
				item := model.Task{Properties: model.TaskProperties{"paused": json.RawMessage(value)}}
				ctx := context.Background()
				var base int64
				var err error
				if mode == "rest" {
					base, err = wire.EncodeREST(io.Discard, item, true, math.MaxInt64)
				} else {
					batch := mode == "mcp-batch"
					ctx = WithMCPTaskResponse(ctx, "request", "<&>", true, batch, true)
					base, err = wire.EncodeMCPResponse(io.Discard, item, "request", "changed", "<&>", true, true, math.MaxInt64)
					if !batch {
						base -= 15
					}
				}
				if err != nil {
					t.Fatal(err)
				}
				item.Description = strings.Repeat("x", int(int64(core.MaxTaskResponseJSONBytes)-base))
				item.Properties = model.TaskProperties{"blocked": json.RawMessage(" \n" + value + " ")}
				if err := admitTaskResponse(ctx, item, true); err != nil {
					t.Fatalf("legacy exact budget rejected: %v", err)
				}
				item.Description += "x"
				err = admitTaskResponse(ctx, item, true)
				var violation *limit.Violation
				if !errors.As(err, &violation) {
					t.Fatalf("one byte over accepted: %v", err)
				}
			})
		}
	}
}
