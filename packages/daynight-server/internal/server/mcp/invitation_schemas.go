package mcp

// Invitation tool discovery schemas follow the published MCP contract.
const invitationSchemas = `[
  {
    "name": "team_invitation_create",
    "description": "Create a single-use Team invitation; its link is returned only here.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "team": {
          "anyOf": [
            {
              "type": "string",
              "format": "uuid"
            },
            {
              "const": "personal"
            }
          ]
        },
        "confirm": {
          "const": true
        }
      },
      "required": [
        "team",
        "confirm"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "team_invitation_list",
    "description": "Read invitation metadata without invitation links or secrets.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "team": {
          "anyOf": [
            {
              "type": "string",
              "format": "uuid"
            },
            {
              "const": "personal"
            }
          ]
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "default": 50
        },
        "cursor": {
          "type": "string"
        }
      },
      "required": [
        "team"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "team_invitation_revoke",
    "description": "Revoke one Team invitation; already revoked is unchanged.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "team": {
          "anyOf": [
            {
              "type": "string",
              "format": "uuid"
            },
            {
              "const": "personal"
            }
          ]
        },
        "invitationId": {
          "type": "string",
          "format": "uuid"
        },
        "confirm": {
          "const": true
        }
      },
      "required": [
        "team",
        "invitationId",
        "confirm"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "invitation_inspect",
    "description": "Inspect a same-service invitation and the current membership.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "link": {
          "type": "string"
        }
      },
      "required": [
        "link"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "invitation_accept",
    "description": "Accept a same-service invitation as the authenticated account.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "link": {
          "type": "string"
        },
        "confirm": {
          "const": true
        }
      },
      "required": [
        "link",
        "confirm"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": false
    }
  }
]`

const invitationOutputSchema = `{
  "type": "object",
  "properties": {
    "data": {
      "type": "object"
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string"
        },
        "outcome": {
          "type": "string"
        }
      },
      "required": [
        "requestId"
      ]
    },
    "error": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "requestId": {
          "type": "string"
        },
        "writeOutcome": {
          "enum": [
            "confirmed",
            "not_committed",
            "unknown"
          ]
        },
        "phase": {
          "type": "string"
        },
        "refs": {
          "type": "object"
        }
      },
      "required": [
        "code",
        "message",
        "requestId"
      ]
    }
  },
  "oneOf": [
    {
      "required": [
        "data",
        "meta"
      ],
      "not": {
        "required": [
          "error"
        ]
      }
    },
    {
      "required": [
        "error"
      ],
      "not": {
        "required": [
          "data"
        ]
      }
    }
  ]
}`

const invitationPageOutputSchema = `{
  "type": "object",
  "properties": {
    "data": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "nextCursor": {
          "type": [
            "string",
            "null"
          ]
        },
        "projection": {
          "enum": [
            "summary",
            "full"
          ]
        }
      },
      "required": [
        "items"
      ]
    },
    "meta": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string"
        },
        "outcome": {
          "type": "string"
        }
      },
      "required": [
        "requestId"
      ]
    },
    "error": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "requestId": {
          "type": "string"
        },
        "writeOutcome": {
          "enum": [
            "confirmed",
            "not_committed",
            "unknown"
          ]
        },
        "phase": {
          "type": "string"
        },
        "refs": {
          "type": "object"
        }
      },
      "required": [
        "code",
        "message",
        "requestId"
      ]
    }
  },
  "oneOf": [
    {
      "required": [
        "data",
        "meta"
      ],
      "not": {
        "required": [
          "error"
        ]
      }
    },
    {
      "required": [
        "error"
      ],
      "not": {
        "required": [
          "data"
        ]
      }
    }
  ]
}`
