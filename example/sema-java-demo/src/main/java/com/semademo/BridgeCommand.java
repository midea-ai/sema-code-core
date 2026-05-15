package com.semademo;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.UUID;

/**
 * 宿主 → Node.js 指令帧
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class BridgeCommand {

    @JsonProperty("id")
    public final String id = UUID.randomUUID().toString().replace("-", "").substring(0, 8);

    @JsonProperty("action")
    public final String action;

    @JsonProperty("payload")
    public final Object payload;

    public BridgeCommand(String action, Object payload) {
        this.action = action;
        this.payload = payload;
    }
}
