// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

/**
 * 宿主内置的模型列表与指针（字段同 addModel / addImageModel 入参）；host 模型只读，查询接口不回传 apiKey。
 * main / quick / image 为 "modelName[provider]"，是没有用户选择时的缺省值：main 缺省取 profiles[0]，quick 缺省同 main，
 * image 缺省取 imageProfiles[0]、传 "" 停用文生图。
 */
public record ModelsInput(List<ModelConfig> profiles, List<ImageModelConfig> imageProfiles, String main, String quick, String image) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private List<ModelConfig> profiles;
        private List<ImageModelConfig> imageProfiles;
        private String main;
        private String quick;
        private String image;
        private Builder() {}
        public Builder profiles(List<ModelConfig> profiles) { this.profiles = profiles; return this; }
        public Builder imageProfiles(List<ImageModelConfig> imageProfiles) { this.imageProfiles = imageProfiles; return this; }
        public Builder main(String main) { this.main = main; return this; }
        public Builder quick(String quick) { this.quick = quick; return this; }
        public Builder image(String image) { this.image = image; return this; }
        public ModelsInput build() { return new ModelsInput(profiles, imageProfiles, main, quick, image); }
    }
}
