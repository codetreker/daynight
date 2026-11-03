package core

import "encoding/json"

type PullRequestProperty struct {
	URL   string
	Title string
}

type TaskProperties map[string]json.RawMessage

type TaskPropertiesPatch = TaskProperties
