import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
// 生成動画の素材は 1080p 以上を想定。書き出しは H.264・高めの品質で（SNS 側で再圧縮されるため）。
Config.setCrf(18);
