package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
)

type batchRPCID struct {
	id         any
	restoreNil bool
}

// objectFields locates values without rewriting any client-owned JSON.
func objectFields(raw []byte, name string) ([][2]int, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return nil, fmt.Errorf("not an object")
	}
	var result [][2]int
	for d.More() {
		key, err := d.Token()
		if err != nil {
			return nil, err
		}
		start := int(d.InputOffset())
		for start < len(raw) && (raw[start] == ' ' || raw[start] == '\n' || raw[start] == '\r' || raw[start] == '\t') {
			start++
		}
		if start >= len(raw) || raw[start] != ':' {
			return nil, fmt.Errorf("missing colon")
		}
		start++
		for start < len(raw) && (raw[start] == ' ' || raw[start] == '\n' || raw[start] == '\r' || raw[start] == '\t') {
			start++
		}
		var value json.RawMessage
		if err := d.Decode(&value); err != nil {
			return nil, err
		}
		if key == name {
			result = append(result, [2]int{start, int(d.InputOffset())})
		}
	}
	_, err = d.Token()
	return result, err
}

func appendObjectField(raw []byte, field []byte) ([]byte, error) {
	trim := bytes.TrimSpace(raw)
	if len(trim) < 2 || trim[0] != '{' || trim[len(trim)-1] != '}' {
		return nil, fmt.Errorf("not an object")
	}
	end := bytes.LastIndexByte(raw, '}')
	var out bytes.Buffer
	out.Write(raw[:end])
	if len(bytes.TrimSpace(trim[1:len(trim)-1])) != 0 {
		out.WriteByte(',')
	}
	out.Write(field)
	out.Write(raw[end:])
	return out.Bytes(), nil
}

func injectBatchMeta(params []byte, key, value string) ([]byte, bool, error) {
	fields, err := objectFields(params, "_meta")
	if err != nil {
		return nil, false, err
	}
	field := []byte(strconv.Quote(key) + ":" + strconv.Quote(value))
	if len(fields) == 0 {
		out, err := appendObjectField(params, append([]byte(`"_meta":{`), append(field, '}')...))
		return out, true, err
	}
	last := fields[len(fields)-1]
	old := params[last[0]:last[1]]
	if bytes.Equal(bytes.TrimSpace(old), []byte("null")) {
		// A preceding duplicate metadata object must still be reset by null.
		insert := append([]byte(`null,"_meta":{`), append(field, '}')...)
		return append(append(bytes.Clone(params[:last[0]]), insert...), params[last[1]:]...), true, nil
	}
	updated, err := appendObjectField(old, field)
	if err != nil {
		return nil, false, err
	}
	return append(append(bytes.Clone(params[:last[0]]), updated...), params[last[1]:]...), false, nil
}

func budgetedToolName(name string) bool {
	switch name {
	case "task_work_list", "task_create", "task_update", "task_set_status", "task_set_property", "task_remove_property":
		return true
	}
	return false
}

// prepareRPCIDs preserves SDK decoding for single calls. For legacy batches,
// an unguessable temporary metadata key correlates each handler with its own
// decoded ID for budgeted tools; all user JSON remains byte-for-byte unchanged apart from insertion.
func prepareRPCIDs(body []byte) ([]byte, any, string, map[string]batchRPCID) {
	if !json.Valid(body) {
		return body, nil, "", nil
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return body, nil, "", nil
	}
	if trimmed[0] != '[' {
		msg, err := jsonrpc.DecodeMessage(trimmed)
		if err == nil {
			if req, ok := msg.(*jsonrpc.Request); ok && req.ID.IsValid() {
				return body, req.ID.Raw(), "", nil
			}
		}
		return body, nil, "", nil
	}
	var messages []json.RawMessage
	if json.Unmarshal(trimmed, &messages) != nil {
		return body, nil, "", nil
	}
	var key string
	// Check decoded strings, including escaped keys, so a client key is never overwritten.
	for {
		key = "dn.internal." + uuid.NewString()
		collision := false
		d := json.NewDecoder(bytes.NewReader(trimmed))
		d.UseNumber()
		for {
			token, err := d.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				return body, nil, "", nil
			}
			if value, ok := token.(string); ok && value == key {
				collision = true
			}
		}
		if !collision {
			break
		}
	}
	ids := map[string]batchRPCID{}
	for index, raw := range messages {
		msg, err := jsonrpc.DecodeMessage(raw)
		if err != nil {
			return body, nil, "", nil
		}
		req, ok := msg.(*jsonrpc.Request)
		if !ok || !req.ID.IsValid() || req.Method != "tools/call" {
			continue
		}
		names, err := objectFields(req.Params, "name")
		if err != nil || len(names) == 0 {
			continue
		}
		var name string
		valid := true
		for _, field := range names {
			if json.Unmarshal(req.Params[field[0]:field[1]], &name) != nil {
				valid = false
				break
			}
		}
		if !valid || !budgetedToolName(name) {
			continue
		}
		fields, err := objectFields(raw, "params")
		if err != nil || len(fields) == 0 {
			continue
		}
		last := fields[len(fields)-1]
		value := strconv.Itoa(index)
		updated, restoreNil, err := injectBatchMeta(raw[last[0]:last[1]], key, value)
		if err != nil {
			continue
		}
		messages[index] = append(append(bytes.Clone(raw[:last[0]]), updated...), raw[last[1]:]...)
		ids[value] = batchRPCID{id: req.ID.Raw(), restoreNil: restoreNil}
	}
	if len(ids) == 0 {
		return body, nil, "", nil
	}
	var out bytes.Buffer
	out.WriteByte('[')
	for i, raw := range messages {
		if i > 0 {
			out.WriteByte(',')
		}
		out.Write(raw)
	}
	out.WriteByte(']')
	return out.Bytes(), nil, key, ids
}
