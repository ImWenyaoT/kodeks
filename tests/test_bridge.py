import pytest

from kodeks.providers.bridge import from_deepseek_stream, to_deepseek_chat_request


def test_bridge_maps_responses_request_to_chat_completions():
    """Responses-shaped input is converted to Chat Completions with tools."""

    payload = to_deepseek_chat_request(
        {
            "model": "bridge",
            "instructions": "Be concise.",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "hi"}],
                }
            ],
            "tools": [
                {
                    "type": "function",
                    "name": "read_file",
                    "description": "Read",
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
            "reasoning": {"effort": "none"},
        },
        model="deepseek-v4-pro",
    )

    assert payload["model"] == "deepseek-v4-pro"
    assert payload["messages"] == [
        {"role": "system", "content": "Be concise."},
        {"role": "user", "content": "hi"},
    ]
    assert payload["thinking"] == {"type": "disabled"}
    assert payload["tool_choice"] == "auto"
    assert payload["tools"][0]["function"]["name"] == "read_file"


def test_bridge_maps_kodeks_tool_definitions_to_chat_completions():
    """Bare Kodeks tool definitions are converted to Chat Completions tools."""

    payload = to_deepseek_chat_request(
        {
            "model": "bridge",
            "input": "read the file",
            "tools": [
                {
                    "name": "read_file",
                    "description": "Read a workspace file.",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                        "required": ["path"],
                    },
                }
            ],
        },
        model="deepseek-v4-pro",
    )

    assert payload["tool_choice"] == "auto"
    assert payload["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a workspace file.",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            },
        }
    ]


def test_bridge_filters_hosted_openai_tools_from_chat_completions():
    """MoonBridge forwards only local function tools to Chat Completions."""

    payload = to_deepseek_chat_request(
        {
            "model": "bridge",
            "input": "hi",
            "tools": [
                {"type": "web_search_preview"},
                {
                    "type": "function",
                    "name": "read_file",
                    "description": "Read",
                    "parameters": {"type": "object", "properties": {}},
                },
            ],
        },
        model="deepseek-v4-pro",
    )

    assert [tool["function"]["name"] for tool in payload["tools"]] == ["read_file"]


def test_bridge_maps_core_replay_items_for_tool_continuation():
    """Function-call replay items keep empty content and reasoning metadata."""

    payload = to_deepseek_chat_request(
        {
            "model": "bridge",
            "instructions": "Follow the policy.",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Read package.json"}],
                },
                {
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "read_file",
                    "reasoning_content": "Need package metadata.",
                    "arguments": '{"path":"package.json"}',
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": '{"name":"kodeks"}',
                },
            ],
            "tools": [],
            "reasoning": {"effort": "xhigh"},
        },
        model="deepseek-v4-pro",
    )

    assert payload["messages"] == [
        {"role": "system", "content": "Follow the policy."},
        {"role": "user", "content": "Read package.json"},
        {
            "role": "assistant",
            "content": "",
            "reasoning_content": "Need package metadata.",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "arguments": '{"path":"package.json"}',
                    },
                }
            ],
        },
        {
            "role": "tool",
            "content": '{"name":"kodeks"}',
            "tool_call_id": "call_1",
        },
    ]
    assert payload["thinking"] == {"type": "enabled"}
    assert payload["reasoning_effort"] == "max"


def test_bridge_merges_multiple_replay_function_calls_into_one_assistant_message():
    """Multiple Responses function_call items replay as one assistant tool-call turn."""

    payload = to_deepseek_chat_request(
        {
            "model": "bridge",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Inspect files"}],
                },
                {
                    "type": "function_call",
                    "call_id": "call_read_test",
                    "name": "read_file",
                    "reasoning_content": "Need both files.",
                    "arguments": '{"path":"tests/test_text_tools.py"}',
                },
                {
                    "type": "function_call",
                    "call_id": "call_read_src",
                    "name": "read_file",
                    "reasoning_content": "Need both files.",
                    "arguments": '{"path":"src/text_tools.py"}',
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_read_test",
                    "output": '{"ok":true}',
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_read_src",
                    "output": '{"ok":true}',
                },
            ],
            "tools": [],
        },
        model="deepseek-v4-pro",
    )

    assert [message["role"] for message in payload["messages"]] == [
        "user",
        "assistant",
        "tool",
        "tool",
    ]
    assistant = payload["messages"][1]
    assert assistant["reasoning_content"] == "Need both files."
    assert [tool_call["id"] for tool_call in assistant["tool_calls"]] == [
        "call_read_test",
        "call_read_src",
    ]


@pytest.mark.asyncio
async def test_bridge_emits_response_failed_for_upstream_errors():
    """Upstream errors become terminal Responses failure events."""

    events = [
        event
        async for event in from_deepseek_stream(
            [{"error": {"message": "boom"}}],
            response_id="resp_test",
            model="bridge",
        )
    ]

    assert events == [
        {
            "type": "response.failed",
            "response": {
                "id": "resp_test",
                "model": "bridge",
                "status": "failed",
                "error": {"message": "boom"},
                "output": [
                    {
                        "id": "msg_resp_test_failed",
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "MoonBridge upstream failed: boom",
                                "annotations": [],
                            }
                        ],
                    }
                ],
            },
        }
    ]


@pytest.mark.asyncio
async def test_bridge_preserves_reasoning_content_on_tool_calls():
    """Tool-call outputs keep DeepSeek reasoning_content for replay."""

    chunks = [
        {
            "id": "resp_1",
            "choices": [
                {
                    "delta": {
                        "reasoning_content": "private",
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_1",
                                "function": {
                                    "name": "read_file",
                                    "arguments": '{"path":"README.md"}',
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
        }
    ]

    events = [event async for event in from_deepseek_stream(chunks, model="bridge")]

    assert events[0]["type"] == "response.output_item.done"
    assert events[0]["item"]["reasoning_content"] == "private"
    assert events[1]["type"] == "response.completed"


@pytest.mark.asyncio
async def test_bridge_merges_tool_call_chunks_for_responses_contract():
    """Chunked tool calls replace id/name fields and append arguments only."""

    chunks = [
        {
            "id": "chatcmpl_1",
            "choices": [
                {
                    "delta": {
                        "content": "Hello",
                    },
                }
            ],
        },
        {
            "id": "chatcmpl_1",
            "choices": [
                {
                    "delta": {
                        "reasoning_content": "Need the package metadata.",
                    },
                }
            ],
        },
        {
            "id": "chatcmpl_1",
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_1",
                                "function": {
                                    "name": "read_file",
                                    "arguments": '{"path":',
                                },
                            }
                        ],
                    },
                }
            ],
        },
        {
            "id": "chatcmpl_1",
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "function": {"arguments": '"package.json"}'},
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
        },
        {"error": {"message": "upstream failed"}},
    ]

    events = [event async for event in from_deepseek_stream(chunks, model="bridge")]

    assert events[0] == {
        "type": "response.output_text.delta",
        "delta": "Hello",
        "output_index": 0,
        "content_index": 0,
        "item_id": "msg_chatcmpl_1",
    }
    assert events[1]["type"] == "response.output_item.done"
    assert events[1]["item"] == {
        "id": "fc_call_1",
        "type": "function_call",
        "call_id": "call_1",
        "name": "read_file",
        "arguments": '{"path":"package.json"}',
        "status": "completed",
        "reasoning_content": "Need the package metadata.",
    }
    assert events[2]["type"] == "response.completed"
    assert events[2]["response"]["output"][0]["content"][0]["text"] == "Hello"
    assert events[2]["response"]["output"][1]["call_id"] == "call_1"
    assert events[3]["type"] == "response.failed"
    assert events[3]["response"]["output"][0]["content"][0]["text"] == (
        "MoonBridge upstream failed: upstream failed"
    )
