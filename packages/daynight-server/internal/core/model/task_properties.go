package model

import "encoding/json"

type PullRequestProperty struct {
	URL   string
	Title string
}

type TaskProperties map[string]json.RawMessage

type TaskPropertiesPatch = TaskProperties
