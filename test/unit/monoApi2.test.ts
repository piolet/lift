import * as sinon from "sinon";
import * as fs from "fs";
import * as path from "path";
import { baseConfig, pluginConfigExt, runServerless } from "../utils/runServerless";
import * as CloudFormationHelpers from "../../src/CloudFormation";
import { computeS3ETag } from "../../src/utils/s3-sync";
import { mockAws } from "../utils/mockAws";

describe("mono api2", () => {
    afterEach(() => {
        sinon.restore();
    });

    it("should create all required resources", async () => {
        const { cfTemplate, computeLogicalId } = await runServerless({
            command: "package",
            config: Object.assign(baseConfig, {
                constructs: {
                    backend: {
                        type: "mono-api2",
                    },
                },
            }),
        });
        const originAccessIdentityLogicalId = computeLogicalId("backend", "CDN", "Origin2", "S3Origin");
        const cfDistributionLogicalId = computeLogicalId("backend", "CDN");
        const cfOriginId1 = computeLogicalId("backend", "CDN", "Origin1");
        const cfOriginId2 = computeLogicalId("backend", "CDN", "Origin2");
        const originPolicyId = computeLogicalId("backend", "BackendOriginPolicy");
        const cachePolicyId = computeLogicalId("backend", "BackendCachePolicy");
        const requestFunction = computeLogicalId("backend", "RequestFunction");
        expect(Object.keys(cfTemplate.Resources)).toStrictEqual([
            "ServerlessDeploymentBucket",
            "ServerlessDeploymentBucketPolicy",
            originPolicyId,
            cachePolicyId,
            requestFunction,
            originAccessIdentityLogicalId,
            cfDistributionLogicalId,
        ]);
        expect(cfTemplate.Resources[originAccessIdentityLogicalId]).toStrictEqual({
            Type: "AWS::CloudFront::CloudFrontOriginAccessIdentity",
            Properties: {
                CloudFrontOriginAccessIdentityConfig: {
                    Comment: `Identity for ${cfOriginId2}`,
                },
            },
        });
        expect(cfTemplate.Resources[cfDistributionLogicalId]).toStrictEqual({
            Type: "AWS::CloudFront::Distribution",
            Properties: {
                DistributionConfig: {
                    Comment: "app-dev backend website CDN",
                    CustomErrorResponses: [
                        { ErrorCachingMinTTL: 0, ErrorCode: 500 },
                        { ErrorCachingMinTTL: 0, ErrorCode: 504 },
                    ],
                    DefaultCacheBehavior: {
                        AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
                        Compress: true,
                        CachePolicyId: { Ref: cachePolicyId },
                        OriginRequestPolicyId: { Ref: originPolicyId },
                        TargetOriginId: cfOriginId1,
                        ViewerProtocolPolicy: "redirect-to-https",
                        FunctionAssociations: [
                            {
                                EventType: "viewer-request",
                                FunctionARN: {
                                    "Fn::GetAtt": [requestFunction, "FunctionARN"],
                                },
                            },
                        ],
                    },
                    Enabled: true,
                    HttpVersion: "http2",
                    IPV6Enabled: true,
                    Origins: [
                        {
                            Id: cfOriginId1,
                            CustomOriginConfig: {
                                OriginProtocolPolicy: "https-only",
                                OriginSSLProtocols: ["TLSv1.2"],
                            },
                            DomainName: {
                                "Fn::Join": [".", [{ Ref: "HttpApi" }, "execute-api.us-east-1.amazonaws.com"]],
                            },
                        },
                    ],
                },
            },
        });
        expect(cfTemplate.Resources[originPolicyId]).toStrictEqual({
            Type: "AWS::CloudFront::OriginRequestPolicy",
            Properties: {
                OriginRequestPolicyConfig: {
                    Name: "app-dev-backend",
                    Comment: "Origin request policy for the backend website.",
                    CookiesConfig: { CookieBehavior: "all" },
                    QueryStringsConfig: { QueryStringBehavior: "all" },
                    HeadersConfig: {
                        HeaderBehavior: "whitelist",
                        Headers: [
                            "Accept",
                            "Accept-Language",
                            "Content-Type",
                            "Origin",
                            "Referer",
                            "User-Agent",
                            "X-Requested-With",
                            "X-Forwarded-Host",
                        ],
                    },
                },
            },
        });
        expect(cfTemplate.Resources[cachePolicyId]).toStrictEqual({
            Type: "AWS::CloudFront::CachePolicy",
            Properties: {
                CachePolicyConfig: {
                    Comment: "Cache policy for the backend website.",
                    DefaultTTL: 0,
                    MaxTTL: 31536000,
                    MinTTL: 0,
                    Name: "app-dev-backend",
                    ParametersInCacheKeyAndForwardedToOrigin: {
                        CookiesConfig: { CookieBehavior: "none" },
                        QueryStringsConfig: { QueryStringBehavior: "none" },
                        HeadersConfig: {
                            HeaderBehavior: "whitelist",
                            Headers: ["Authorization"],
                        },
                        EnableAcceptEncodingBrotli: false,
                        EnableAcceptEncodingGzip: false,
                    },
                },
            },
        });
        expect(cfTemplate.Outputs).toMatchObject({
            [computeLogicalId("backend", "Domain")]: {
                Description: "Website domain name.",
                Value: { "Fn::GetAtt": [cfDistributionLogicalId, "DomainName"] },
            },
            [computeLogicalId("backend", "CloudFrontCName")]: {
                Description: "CloudFront CNAME.",
                Value: { "Fn::GetAtt": [cfDistributionLogicalId, "DomainName"] },
            },
            [computeLogicalId("backend", "DistributionId")]: {
                Description: "ID of the CloudFront distribution.",
                Value: { Ref: cfDistributionLogicalId },
            },
        });
    });

    it("assets should be optional", async () => {
        const { cfTemplate, computeLogicalId } = await runServerless({
            command: "package",
            config: Object.assign(baseConfig, {
                constructs: {
                    backend: {
                        type: "mono-api2",
                    },
                },
            }),
        });
        const cfDistributionLogicalId = computeLogicalId("backend", "CDN");
        const cfOriginId1 = computeLogicalId("backend", "CDN", "Origin1");
        const originPolicyId = computeLogicalId("backend", "BackendOriginPolicy");
        const cachePolicyId = computeLogicalId("backend", "BackendCachePolicy");
        const requestFunction = computeLogicalId("backend", "RequestFunction");
        expect(Object.keys(cfTemplate.Resources)).toStrictEqual([
            "ServerlessDeploymentBucket",
            "ServerlessDeploymentBucketPolicy",
            originPolicyId,
            cachePolicyId,
            requestFunction,
            cfDistributionLogicalId,
        ]);
        expect(cfTemplate.Resources[cfDistributionLogicalId]).toStrictEqual({
            Type: "AWS::CloudFront::Distribution",
            Properties: {
                DistributionConfig: {
                    Comment: "app-dev backend website CDN",
                    CustomErrorResponses: [
                        { ErrorCachingMinTTL: 0, ErrorCode: 500 },
                        { ErrorCachingMinTTL: 0, ErrorCode: 504 },
                    ],
                    DefaultCacheBehavior: {
                        AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
                        Compress: true,
                        CachePolicyId: { Ref: cachePolicyId },
                        OriginRequestPolicyId: { Ref: originPolicyId },
                        TargetOriginId: cfOriginId1,
                        ViewerProtocolPolicy: "redirect-to-https",
                        FunctionAssociations: [
                            {
                                EventType: "viewer-request",
                                FunctionARN: { "Fn::GetAtt": [requestFunction, "FunctionARN"] },
                            },
                        ],
                    },
                    Enabled: true,
                    HttpVersion: "http2",
                    IPV6Enabled: true,
                    Origins: [
                        {
                            Id: cfOriginId1,
                            CustomOriginConfig: {
                                OriginProtocolPolicy: "https-only",
                                OriginSSLProtocols: ["TLSv1.2"],
                            },
                            DomainName: {
                                "Fn::Join": [".", [{ Ref: "HttpApi" }, "execute-api.us-east-1.amazonaws.com"]],
                            },
                        },
                    ],
                },
            },
        });
    });

    it("should support a custom domain", async () => {
        const { cfTemplate, computeLogicalId } = await runServerless({
            command: "package",
            config: Object.assign(baseConfig, {
                constructs: {
                    backend: {
                        type: "mono-api2",
                        domain: "api.example.com",
                        certificate:
                            "arn:aws:acm:us-east-1:123456615250:certificate/0a28e63d-d3a9-4578-9f8b-14347bfe8123",
                    },
                },
            }),
        });
        const cfDistributionLogicalId = computeLogicalId("backend", "CDN");
        expect(cfTemplate.Resources[cfDistributionLogicalId]).toMatchObject({
            Type: "AWS::CloudFront::Distribution",
            Properties: {
                DistributionConfig: {
                    // Check that CloudFront uses the custom ACM certificate and custom domain
                    Aliases: ["example.com"],
                    ViewerCertificate: {
                        AcmCertificateArn:
                            "arn:aws:acm:us-east-1:123456615250:certificate/0a28e63d-d3a9-4578-9f8b-14347bfe8123",
                        MinimumProtocolVersion: "TLSv1.2_2019",
                        SslSupportMethod: "sni-only",
                    },
                },
            },
        });
        // The domain should be the custom domain, not the CloudFront one
        expect(cfTemplate.Outputs).toMatchObject({
            [computeLogicalId("backend", "Domain")]: {
                Description: "Api domain name.",
                Value: "example.com",
            },
            [computeLogicalId("backend", "CloudFrontCName")]: {
                Description: "CloudFront CNAME.",
                Value: {
                    "Fn::GetAtt": [cfDistributionLogicalId, "DomainName"],
                },
            },
        });
    });

    it("should allow to override the forwarded headers", async () => {
        const { cfTemplate, computeLogicalId } = await runServerless({
            command: "package",
            config: Object.assign(baseConfig, {
                constructs: {
                    backend: {
                        type: "mono-api2",
                        forwardedHeaders: ["X-My-Custom-Header", "X-My-Other-Custom-Header"],
                    },
                },
            }),
        });
        expect(cfTemplate.Resources[computeLogicalId("backend", "BackendOriginPolicy")]).toMatchObject({
            Properties: {
                OriginRequestPolicyConfig: {
                    HeadersConfig: {
                        HeaderBehavior: "whitelist",
                        Headers: ["X-My-Custom-Header", "X-My-Other-Custom-Header"],
                    },
                },
            },
        });
    });

    it("should not forward the Authorization header in the Origin Policy", async () => {
        const { cfTemplate, computeLogicalId } = await runServerless({
            command: "package",
            config: Object.assign(baseConfig, {
                constructs: {
                    backend: {
                        type: "mono-api2",
                        forwardedHeaders: ["Authorization", "X-My-Custom-Header"],
                    },
                },
            }),
        });
        expect(cfTemplate.Resources[computeLogicalId("backend", "BackendOriginPolicy")]).toMatchObject({
            Properties: {
                OriginRequestPolicyConfig: {
                    HeadersConfig: {
                        // Should not contain "Authorization"
                        Headers: ["X-My-Custom-Header"],
                    },
                },
            },
        });
    });

    it("should forbid to force forwarding the Host header", async () => {
        await expect(() => {
            return runServerless({
                command: "package",
                config: Object.assign(baseConfig, {
                    constructs: {
                        backend: {
                            type: "mono-api2",
                            forwardedHeaders: ["Host"],
                        },
                    },
                }),
            });
        }).rejects.toThrowError(
            "Invalid value in 'constructs.backend.forwardedHeaders': the 'Host' header cannot be forwarded (this is an API Gateway limitation). Use the 'X-Forwarded-Host' header in your code instead (it contains the value of the original 'Host' header)."
        );
    });

    it("should error if more than 10 headers are configured", async () => {
        await expect(() => {
            return runServerless({
                command: "package",
                config: Object.assign(baseConfig, {
                    constructs: {
                        backend: {
                            type: "mono-api2",
                            forwardedHeaders: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
                        },
                    },
                }),
            });
        }).rejects.toThrowError(
            "Invalid value in 'constructs.backend.forwardedHeaders': 11 headers are configured but only 10 headers can be forwarded (this is an CloudFront limitation)."
        );
    });
});
