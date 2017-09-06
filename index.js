'use strict';
const aws = require('aws-sdk');
const co = require('co');
const dynamodb = new aws.DynamoDB({region: 'ap-northeast-1'});
const cw = new aws.CloudWatch({region: 'ap-northeast-1'});
const slack = require('slack');


exports.handler = function (event, context, callback) {
    co(function *() {
        let indexList = [];
        let tableList = yield getTableList();
        tableList.forEach((val, count) => {
            getTableIndex(val).then(e => {
                if (e !== undefined) indexList.push(e);

                if (count === tableList.length - 1) {
                    indexList.forEach((obj, cnt) => {
                        let tasks = [
                            getReadCapacity(obj),
                            getWriteCapacity(obj)
                        ];
                        Promise.all(tasks).catch(err => {
                            console.log(err);
                        });

                        if (cnt === indexList.length - 1) callback();
                    });
                }
            });
        });
    });
};



function getTableList(LastEvaluatedTableName, tableList) {
    return new Promise((resolve, reject) => {
        let list = [];
        if (tableList) list = tableList;
        let params = {Limit: 100};
        if (LastEvaluatedTableName) params['ExclusiveStartTableName'] = LastEvaluatedTableName;

        dynamodb.listTables(params, function (err, data) {
            if (err) {
                console.log('[ERROR] getTableList function error...', err);
                reject(err);
            } else {
                if (data.LastEvaluatedTableName) {
                    list = list.concat(data.TableNames);
                    resolve(getTableList(data.LastEvaluatedTableName, list));
                } else {
                    list = list.concat(data.TableNames);
                    resolve(list);
                }
            }
        });
    });
}

function getTableIndex(tableName) {
    return new Promise((resolve, reject) => {
        let resObj = {
            TableName: tableName,
            GlobalSecondaryIndexes: []
        };
        let params = {
            TableName: tableName
        };
        dynamodb.describeTable(params, (err, data) => {
            if (err) reject(err);
            else {
                if (data.Table.GlobalSecondaryIndexes) {
                    data.Table.GlobalSecondaryIndexes.forEach(val => {
                        let obj = {
                            IndexName: val.IndexName,
                            ProvisionedReadCapacityUnits: val.ProvisionedThroughput.ReadCapacityUnits,
                            ProvisionedWriteCapacityUnits: val.ProvisionedThroughput.WriteCapacityUnits,
                        };
                        resObj.GlobalSecondaryIndexes.push(obj);
                    });
                    resolve(resObj);
                }
                resolve();
            }
        });
    });
}

function getReadCapacity(obj) {
    return new Promise((resolve, reject) => {
        let len = obj.GlobalSecondaryIndexes.length;
        let lim = 0;
        for (let i = 0; i < len; i++) {
            let params = {
                EndTime: new Date(),
                StartTime: new Date(+new Date() - (6 * 60 * 1000)),
                Period: 60,
                Dimensions: [
                    {
                        Name: 'TableName',
                        Value: obj.TableName
                    },
                    {
                        Name: 'GlobalSecondaryIndexName',
                        Value: obj.GlobalSecondaryIndexes[i].IndexName
                    },
                ],
                MetricName: 'ConsumedReadCapacityUnits',
                Namespace: 'AWS/DynamoDB',
                Statistics: ['Sum']
            };
            cw.getMetricStatistics(params, function (err, data) {
                lim++;
                if (err) {
                    console.log("Error", err);
                    reject(err);
                } else {
                    let sumList = [];
                    if (data.Datapoints.length > 0) {
                        data.Datapoints.forEach(data => {
                            let sum = Number(data.Sum) / 60;
                            sumList.push(Number(sum.toFixed(3)));
                        });
                        let val = sumList.reduce(function (previousValue, currentValue) {
                            return previousValue + currentValue;
                        });
                        let crc = Number((val / sumList.length).toFixed(3));
                        let prc = Number(obj.GlobalSecondaryIndexes[i].ProvisionedReadCapacityUnits);

                        if (crc > prc) {
                            let msg = {
                                table: obj.TableName,
                                index: obj.GlobalSecondaryIndexes[i].IndexName,
                                ProvisionedCapacityUnits: prc,
                                ConsumedCapacityUnits: crc,
                                warn: true,
                                units: 'Read'
                            };
                            console.log(msg);
                            postSlack(msg);
                        } else {
                            let msg = {
                                table: obj.TableName,
                                index: obj.GlobalSecondaryIndexes[0].IndexName,
                                ProvisionedCapacityUnits: prc,
                                ConsumedCapacityUnits: crc,
                                warn: false,
                                units: 'Read'
                            };
                            console.log(msg);
                        }
                    }
                }
                if (lim === len) resolve();
            });
        }
    });
}

function getWriteCapacity(obj) {
    return new Promise((resolve, reject) => {
        let len = obj.GlobalSecondaryIndexes.length;
        let lim = 0;
        for (let i = 0; i < len; i++) {
            let params = {
                EndTime: new Date(),
                StartTime: new Date(+new Date() - (6 * 60 * 1000)),
                Period: 60,
                Dimensions: [
                    {
                        Name: 'TableName',
                        Value: obj.TableName
                    },
                    {
                        Name: 'GlobalSecondaryIndexName',
                        Value: obj.GlobalSecondaryIndexes[i].IndexName
                    },
                ],
                MetricName: 'ConsumedWriteCapacityUnits',
                Namespace: 'AWS/DynamoDB',
                Statistics: ['Sum']
            };
            cw.getMetricStatistics(params, function (err, data) {
                lim++;
                if (err) {
                    console.log("Error", err);
                    reject(err);
                } else {
                    let sumList = [];
                    if (data.Datapoints.length > 0) {
                        data.Datapoints.forEach(data => {
                            let sum = Number(data.Sum) / 60;
                            sumList.push(Number(sum.toFixed(3)));
                        });
                        let val = sumList.reduce(function (previousValue, currentValue) {
                            return previousValue + currentValue;
                        });
                        let cwc = Number((val / sumList.length).toFixed(3));
                        let pwc = Number(obj.GlobalSecondaryIndexes[i].ProvisionedWriteCapacityUnits);
                        if (cwc > pwc) {
                            let msg = {
                                table: obj.TableName,
                                index: obj.GlobalSecondaryIndexes[i].IndexName,
                                ProvisionedCapacityUnits: pwc,
                                ConsumedCapacityUnits: cwc,
                                warn: true,
                                units: 'Write'
                            };
                            console.log(msg);
                            postSlack(msg);
                        } else {
                            let msg = {
                                table: obj.TableName,
                                index: obj.GlobalSecondaryIndexes[i].IndexName,
                                ProvisionedCapacityUnits: pwc,
                                ConsumedCapacityUnits: cwc,
                                warn: false,
                                units: 'Write'
                            };
                            console.log(msg);
                        }
                    }
                }
                if (lim === len) resolve();
            });
        }
    });
}

function postSlack(data) {
    let param = {
        token: process.env.token,
        channel: process.env.channel,
        username: process.env.username,
        icon_url: process.env.icon,
        text: "[WARN] DynamoDB: " + data.table + " \n"
        + "Index: " + data.index + "\n"
        + "Capacity: [" + data.units + "] " + data.ProvisionedCapacityUnits + "\n"
        + "INFO: " + JSON.stirngify(data)
    };
    slack.chat.postMessage(param, (err, data) => {
        if (err) {
            console.log('[ERROR] slack: ', err);
        }
        else {
            console.log('[INFO] slack', data);
        }
    });
}
