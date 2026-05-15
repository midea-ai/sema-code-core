package com.semademo;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * Node.js → 宿主 事件帧
 */
public class BridgeEvent {

    @JsonProperty("event")
    public String event;

    @JsonProperty("data")
    public JsonNode data;

    @JsonProperty("cmdId")
    public String cmdId;

    @JsonProperty("error")
    public String error;
}
